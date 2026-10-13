begin;

-- Server-managed identities; callers cannot choose a handset or another client.
create table public.sms_ingest_clients (
  id text primary key check (length(id) between 1 and 100),
  device_id uuid not null references public.sms_devices(id),
  enabled boolean not null default false
);
create index sms_ingest_clients_device_idx on public.sms_ingest_clients(device_id);
create table public.sms_ingest_receipts (
  dedupe_key text primary key check (length(dedupe_key) between 1 and 200),
  client_id text not null references public.sms_ingest_clients(id),
  queue_id uuid not null unique references public.sms_queue(id),
  frozen_payload jsonb not null,
  created_at timestamptz not null default now()
);
create index sms_ingest_receipts_client_idx on public.sms_ingest_receipts(client_id);
alter table public.sms_ingest_clients enable row level security;
alter table public.sms_ingest_receipts enable row level security;
revoke all on public.sms_ingest_clients, public.sms_ingest_receipts from public, anon, authenticated, service_role;
-- PostgreSQL requires UPDATE on at least one column for SELECT ... FOR SHARE.
-- This server-only grant lets ingest fence concurrent enablement/routing changes.
grant select, update(enabled) on public.sms_ingest_clients to service_role;
grant select, insert on public.sms_ingest_receipts to service_role;

create function public.producer_sms_status(p_client_id text, p_queue_id uuid default null, p_dedupe_key text default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', q.id, 'dedupe_key', r.dedupe_key, 'status', q.status,
    'scheduled_at', q.scheduled_at, 'claimed_at', q.claimed_at,
    'sent_at', q.sent_at, 'failed_at', q.failed_at,
    -- Raw backend diagnostics may contain contact data. Keep details server-side.
    'last_error', case when q.last_error is null then null else 'SMS transport reported an error; operator review required' end,
    'attempt_status', a.state
  )
  from public.sms_ingest_receipts r
  join public.sms_ingest_clients c on c.id = r.client_id and c.enabled
  join public.sms_queue q on q.id = r.queue_id
  left join public.sms_send_attempts a on a.id = q.current_attempt_id and a.queue_id = q.id
  where r.client_id = p_client_id
    and (p_queue_id is not null or p_dedupe_key is not null)
    and (p_queue_id is null or q.id = p_queue_id)
    and (p_dedupe_key is null or r.dedupe_key = p_dedupe_key);
$$;

create function public.producer_enqueue_sms(
  p_client_id text, p_dedupe_key text, p_phone text, p_message text,
  p_lead_id text default null, p_event_type text default null,
  p_scheduled_at timestamptz default null
) returns jsonb language plpgsql security invoker set search_path = '' set timezone = 'UTC' as $$
declare
  v_client public.sms_ingest_clients%rowtype;
  v_receipt public.sms_ingest_receipts%rowtype;
  v_payload jsonb;
  v_queue_id uuid;
begin
  if p_dedupe_key is null or length(btrim(p_dedupe_key)) = 0 or length(p_dedupe_key) > 200
     or p_phone is null or p_phone !~ '^\+1[0-9]{10}$'
     or p_message is null or length(p_message) = 0 or length(p_message) > 160
     or (p_scheduled_at is not null and not isfinite(p_scheduled_at)) then
    raise exception using errcode = '22023', message = 'Invalid producer payload';
  end if;
  select * into v_client from public.sms_ingest_clients where id = p_client_id for share;
  if not found or not v_client.enabled then
    return jsonb_build_object('result', 'client_unavailable');
  end if;
  v_payload := jsonb_build_object('phone', p_phone, 'message', p_message,
    'lead_id', p_lead_id, 'event_type', p_event_type,
    'scheduled_at', p_scheduled_at, 'device_id', v_client.device_id);
  -- Serialize the global dedupe identity. Hash collisions only add contention.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_dedupe_key, 0));
  select * into v_receipt from public.sms_ingest_receipts where dedupe_key = p_dedupe_key;
  if found then
    if v_receipt.client_id <> p_client_id or v_receipt.frozen_payload <> v_payload then
      return jsonb_build_object('result', 'conflict');
    end if;
    return jsonb_build_object('result', 'duplicate', 'queued',
      public.producer_sms_status(p_client_id, v_receipt.queue_id));
  end if;
  if not exists (select 1 from public.sms_devices where id = v_client.device_id and enabled) then
    return jsonb_build_object('result', 'client_unavailable');
  end if;
  -- Legacy/manual keys have no trustworthy frozen producer receipt; fail closed.
  insert into public.sms_queue(to_phone, body, lead_id, event_type, dedupe_key, scheduled_at, device_id, metadata)
    values(p_phone, p_message, p_lead_id, p_event_type, p_dedupe_key,
      coalesce(p_scheduled_at, now()), v_client.device_id, '{"source":"lead-automation"}'::jsonb)
    on conflict (dedupe_key) do nothing returning id into v_queue_id;
  if v_queue_id is null then
    return jsonb_build_object('result', 'conflict');
  end if;
  insert into public.sms_ingest_receipts(dedupe_key, client_id, queue_id, frozen_payload)
    values(p_dedupe_key, p_client_id, v_queue_id, v_payload);
  return jsonb_build_object('result', 'created', 'queued',
    public.producer_sms_status(p_client_id, v_queue_id));
end;
$$;

revoke all on function public.producer_sms_status(text, uuid, text) from public, anon, authenticated;
revoke all on function public.producer_enqueue_sms(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.producer_sms_status(text, uuid, text) to service_role;
grant execute on function public.producer_enqueue_sms(text, text, text, text, text, text, timestamptz) to service_role;
commit;
