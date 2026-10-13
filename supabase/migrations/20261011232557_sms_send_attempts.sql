-- Phase 1 only. Stop legacy gateways before applying; Android is not yet compatible.
-- Never replay a legacy claim: it may already have reached SmsManager.
begin;

-- The unchanged baseline assumes pgcrypto lives in public. Supabase normally
-- installs it in extensions. Bind its actual schema without trusting search_path.
do $migration$
declare crypto_schema text;
begin
  select n.nspname into strict crypto_schema from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
  execute format($definition$
    create or replace function public.hash_sms_device_token(p_token text)
    returns text language sql immutable strict set search_path = '' as $body$
      select pg_catalog.encode(%I.digest(p_token, 'sha256'), 'hex');
    $body$;
  $definition$, crypto_schema);
  execute format($definition$
    create or replace function public.create_sms_device(p_name text, p_phone text default null)
    returns table(device_id uuid, device_token text)
    language plpgsql security definer set search_path = '' as $body$
    declare raw_token text; new_id uuid;
    begin
      if nullif(trim(coalesce(p_name, '')), '') is null then
        raise exception 'Device name is required' using errcode = '22023';
      end if;
      raw_token := pg_catalog.encode(%I.gen_random_bytes(32), 'hex');
      insert into public.sms_devices(name, phone, token_hash)
        values (trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), public.hash_sms_device_token(raw_token))
        returning id into new_id;
      return query select new_id, raw_token;
    end;
    $body$;
  $definition$, crypto_schema);
end;
$migration$;
-- Supabase installations can grant EXECUTE directly through default privileges.
revoke all on function public.hash_sms_device_token(text), public.require_sms_device(text),
  public.create_sms_device(text, text) from public, anon, authenticated, service_role;
grant execute on function public.hash_sms_device_token(text), public.require_sms_device(text),
  public.create_sms_device(text, text) to service_role;

alter table public.sms_queue drop constraint sms_queue_status_check;
alter table public.sms_queue add constraint sms_queue_status_check
  check (status in ('queued', 'claimed', 'sending', 'unknown', 'sent', 'failed', 'cancelled'));
update public.sms_queue
set status = 'unknown',
    last_error = 'Legacy claim quarantined: send outcome requires reconciliation',
    updated_at = clock_timestamp()
where status = 'claimed';

create table public.sms_send_attempts (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references public.sms_queue(id),
  device_id uuid not null references public.sms_devices(id),
  claim_request_id uuid not null,
  state text not null check (state in ('claimed', 'sending', 'unknown', 'sent', 'failed', 'expired', 'cancelled')),
  claimed_at timestamptz not null,
  claim_expires_at timestamptz not null,
  send_authorized_at timestamptz,
  outcome_due_at timestamptz,
  outcome_event_id uuid,
  completed_at timestamptz,
  sms_message_id text,
  error text,
  outcome_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome_metadata) = 'object'),
  unique (device_id, claim_request_id),
  unique (queue_id, id),
  check (claim_expires_at > claimed_at),
  check ((send_authorized_at is null) = (outcome_due_at is null)),
  check (outcome_due_at is null or outcome_due_at > send_authorized_at),
  check (state not in ('claimed', 'expired', 'cancelled') or send_authorized_at is null),
  check (state not in ('sending', 'unknown', 'sent') or send_authorized_at is not null),
  check ((state in ('sent', 'failed')) = (outcome_event_id is not null)),
  check ((state in ('sent', 'failed', 'expired', 'cancelled')) = (completed_at is not null))
);
create unique index sms_attempt_one_active_queue on public.sms_send_attempts(queue_id)
  where state in ('claimed', 'sending', 'unknown');
create unique index sms_attempt_one_active_device on public.sms_send_attempts(device_id)
  where state in ('claimed', 'sending', 'unknown');
create index sms_attempt_claim_expiry on public.sms_send_attempts(claim_expires_at)
  where state = 'claimed';
create index sms_attempt_outcome_due on public.sms_send_attempts(outcome_due_at)
  where state = 'sending';

alter table public.sms_queue add column current_attempt_id uuid;
alter table public.sms_queue add constraint sms_queue_current_attempt_fk
  foreign key (id, current_attempt_id) references public.sms_send_attempts(queue_id, id);
alter table public.sms_queue add constraint sms_queue_live_attempt_check
  check (status not in ('claimed', 'sending') or current_attempt_id is not null);
alter table public.sms_send_log add column attempt_id uuid references public.sms_send_attempts(id);
create unique index sms_send_log_one_terminal_attempt on public.sms_send_log(attempt_id);

-- Empty/busy results must also survive a lost HTTP response. Never prune these
-- receipts while a device can replay its request IDs.
create table public.sms_claim_requests (
  device_id uuid not null references public.sms_devices(id),
  claim_request_id uuid not null,
  result text not null check (result in ('claimed', 'empty', 'busy')),
  attempt_id uuid references public.sms_send_attempts(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (device_id, claim_request_id),
  check (result <> 'claimed' or attempt_id is not null)
);
create index sms_claim_requests_attempt_idx on public.sms_claim_requests(attempt_id);
create index sms_attempt_device_idx on public.sms_send_attempts(device_id);

alter table public.sms_send_attempts enable row level security;
alter table public.sms_claim_requests enable row level security;
revoke all on public.sms_send_attempts, public.sms_claim_requests from public, anon, authenticated;
grant select on public.sms_send_attempts, public.sms_claim_requests to service_role;

create schema if not exists enrollment_sms_private;
revoke all on schema enrollment_sms_private from public, anon, authenticated;

-- Every mutation takes locks in the order device -> queue -> attempt. A device
-- lock serializes even different request IDs. Other devices use SKIP LOCKED.
create function enrollment_sms_private.lock_device(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d public.sms_devices;
begin
  d := public.require_sms_device(p_token);
  perform 1 from public.sms_devices where id = d.id and enabled for update;
  if not found then raise exception 'Invalid or disabled device token' using errcode = '42501'; end if;
  return d.id;
end;
$$;

create function enrollment_sms_private.lock_attempt(p_device_id uuid, p_attempt_id uuid)
returns public.sms_send_attempts language plpgsql security definer set search_path = '' as $$
declare a public.sms_send_attempts;
begin
  select * into a from public.sms_send_attempts where id = p_attempt_id and device_id = p_device_id;
  if not found then raise exception 'Attempt not found for this device' using errcode = '42501'; end if;
  perform 1 from public.sms_queue where id = a.queue_id for update;
  select * into a from public.sms_send_attempts where id = p_attempt_id for update;
  return a;
end;
$$;

create function enrollment_sms_private.reconcile_device(p_device_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.sms_send_attempts; v_id uuid; v_now timestamptz;
begin
  -- Caller holds the device lock. There can be at most one active attempt.
  select id into v_id from public.sms_send_attempts
    where device_id = p_device_id and state in ('claimed', 'sending', 'unknown');
  if v_id is null then return; end if;
  a := enrollment_sms_private.lock_attempt(p_device_id, v_id);
  v_now := clock_timestamp();
  if not exists (select 1 from public.sms_queue where id = a.queue_id and current_attempt_id = a.id and status = a.state) then
    raise exception 'Queue/attempt state mismatch' using errcode = '55000';
  end if;
  if a.state = 'claimed' and a.claim_expires_at <= v_now then
    update public.sms_send_attempts set state = 'expired', completed_at = v_now where id = a.id;
    update public.sms_queue set status = 'queued', current_attempt_id = null,
      claimed_by = null, claimed_at = null, updated_at = v_now where id = a.queue_id;
  elsif a.state = 'sending' and a.outcome_due_at <= v_now then
    update public.sms_send_attempts set state = 'unknown' where id = a.id;
    update public.sms_queue set status = 'unknown', updated_at = v_now,
      last_error = 'Send outcome deadline elapsed; do not automatically resend' where id = a.queue_id;
  end if;
end;
$$;

create function enrollment_sms_private.attempt_receipt(a public.sms_send_attempts)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('attempt_id', a.id, 'queue_id', a.queue_id,
    'state', a.state, 'claim_expires_at', a.claim_expires_at,
    'send_authorized_at', a.send_authorized_at, 'outcome_due_at', a.outcome_due_at,
    'outcome_event_id', a.outcome_event_id, 'completed_at', a.completed_at);
$$;

-- Remove unsafe overloads, including privileges inherited from installation
-- defaults. The old Android app must not continue claiming or marking by queue ID.
drop function public.device_claim_sms_queue(text, integer);
drop function public.device_mark_sms_sent(text, uuid, text, jsonb);
drop function public.device_mark_sms_failed(text, uuid, text, jsonb);

create function public.device_claim_sms_queue(p_device_token text, p_claim_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_device uuid; r public.sms_claim_requests; a public.sms_send_attempts;
  q public.sms_queue; v_now timestamptz;
begin
  if p_claim_request_id is null then raise exception 'claim_request_id is required' using errcode = '22023'; end if;
  v_device := enrollment_sms_private.lock_device(p_device_token);
  perform enrollment_sms_private.reconcile_device(v_device);
  select * into r from public.sms_claim_requests
    where device_id = v_device and claim_request_id = p_claim_request_id;
  if found then
    if r.result <> 'claimed' then
      return jsonb_build_object('result', r.result, 'claim_request_id', p_claim_request_id, 'attempt_id', r.attempt_id);
    end if;
    select * into a from public.sms_send_attempts where id = r.attempt_id;
    select * into q from public.sms_queue where id = a.queue_id;
  else
    select * into a from public.sms_send_attempts
      where device_id = v_device and state in ('claimed', 'sending', 'unknown');
    if found or exists (select 1 from public.sms_queue where status = 'unknown'
        and current_attempt_id is null and (device_id = v_device or claimed_by = v_device)) then
      insert into public.sms_claim_requests(device_id, claim_request_id, result, attempt_id)
        values (v_device, p_claim_request_id, 'busy', a.id);
      return jsonb_build_object('result', 'busy', 'claim_request_id', p_claim_request_id, 'attempt_id', a.id);
    end if;
    select * into q from public.sms_queue
      where status = 'queued' and scheduled_at <= clock_timestamp()
        and (device_id is null or device_id = v_device)
      order by scheduled_at, created_at, id limit 1 for update skip locked;
    if not found then
      insert into public.sms_claim_requests(device_id, claim_request_id, result)
        values (v_device, p_claim_request_id, 'empty');
      return jsonb_build_object('result', 'empty', 'claim_request_id', p_claim_request_id, 'attempt_id', null);
    end if;
    v_now := clock_timestamp();
    insert into public.sms_send_attempts(queue_id, device_id, claim_request_id, state, claimed_at, claim_expires_at)
      values (q.id, v_device, p_claim_request_id, 'claimed', v_now, v_now + interval '2 minutes') returning * into a;
    update public.sms_queue set status = 'claimed', current_attempt_id = a.id,
      claimed_by = v_device, claimed_at = v_now, attempts = attempts + 1, updated_at = v_now
      where id = q.id returning * into q;
    insert into public.sms_claim_requests(device_id, claim_request_id, result, attempt_id)
      values (v_device, p_claim_request_id, 'claimed', a.id);
  end if;
  -- Retry returns current state, never a fresh send authorization. Message
  -- content is returned only for a claim that is still usable.
  return enrollment_sms_private.attempt_receipt(a) || jsonb_build_object(
    'result', a.state, 'claim_request_id', p_claim_request_id,
    'message', case when a.state = 'claimed' then jsonb_build_object(
      'id', q.id, 'to_phone', q.to_phone, 'body', q.body, 'metadata', q.metadata) else null end);
end;
$$;

create function public.device_begin_sms_attempt(p_device_token text, p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_device uuid; a public.sms_send_attempts; v_now timestamptz;
begin
  v_device := enrollment_sms_private.lock_device(p_device_token);
  perform enrollment_sms_private.reconcile_device(v_device);
  a := enrollment_sms_private.lock_attempt(v_device, p_attempt_id);
  if a.state = 'claimed' then
    if not exists (select 1 from public.sms_queue where id = a.queue_id and current_attempt_id = a.id and status = 'claimed') then
      raise exception 'Queue/attempt state mismatch' using errcode = '55000';
    end if;
    v_now := clock_timestamp();
    -- Recheck after locking; never authorize based on transaction-start time.
    if a.claim_expires_at <= v_now then
      perform enrollment_sms_private.reconcile_device(v_device);
      select * into a from public.sms_send_attempts where id = p_attempt_id;
    else
      update public.sms_send_attempts set state = 'sending', send_authorized_at = v_now,
        outcome_due_at = v_now + interval '5 minutes' where id = a.id returning * into a;
      update public.sms_queue set status = 'sending', updated_at = v_now where id = a.queue_id;
    end if;
  end if;
  -- expired/unknown/terminal responses are not permission to send. Repeated
  -- sending responses do not extend deadlines or authorize a second submission.
  return enrollment_sms_private.attempt_receipt(a);
end;
$$;

create function enrollment_sms_private.finish_attempt(
  p_device_token text, p_queue_id uuid, p_attempt_id uuid, p_outcome_event_id uuid,
  p_state text, p_sms_message_id text, p_error text, p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_device uuid; a public.sms_send_attempts; v_now timestamptz;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_sms_id text := nullif(trim(coalesce(p_sms_message_id, '')), '');
  v_error text := nullif(trim(coalesce(p_error, '')), '');
begin
  if p_outcome_event_id is null or p_state not in ('sent', 'failed') or jsonb_typeof(v_metadata) <> 'object' then
    raise exception 'A valid outcome event ID, state and metadata object are required' using errcode = '22023';
  end if;
  v_device := enrollment_sms_private.lock_device(p_device_token);
  a := enrollment_sms_private.lock_attempt(v_device, p_attempt_id);
  if a.queue_id is distinct from p_queue_id then raise exception 'Queue/attempt mismatch' using errcode = '22023'; end if;
  if a.state in ('sent', 'failed') then
    if a.state <> p_state or a.outcome_event_id <> p_outcome_event_id
        or a.sms_message_id is distinct from v_sms_id or a.error is distinct from v_error
        or a.outcome_metadata is distinct from v_metadata then
      raise exception 'Conflicting terminal outcome' using errcode = '23514';
    end if;
    return enrollment_sms_private.attempt_receipt(a);
  end if;
  if not exists (select 1 from public.sms_queue where id = a.queue_id and current_attempt_id = a.id and status = a.state) then
    raise exception 'Attempt is not current' using errcode = '55000';
  end if;
  v_now := clock_timestamp();
  if a.state not in ('sending', 'unknown') and not
      (a.state = 'claimed' and p_state = 'failed' and a.claim_expires_at > v_now) then
    raise exception 'Invalid terminal transition' using errcode = '55000';
  end if;
  update public.sms_send_attempts set state = p_state, outcome_event_id = p_outcome_event_id,
    completed_at = v_now, sms_message_id = v_sms_id, error = v_error, outcome_metadata = v_metadata
    where id = a.id returning * into a;
  update public.sms_queue set status = p_state,
    sent_at = case when p_state = 'sent' then v_now else null end,
    failed_at = case when p_state = 'failed' then v_now else null end,
    last_error = v_error, metadata = metadata || v_metadata, updated_at = v_now where id = a.queue_id;
  insert into public.sms_send_log(queue_id, device_id, attempt_id, status, sms_message_id, error, metadata, occurred_at)
    values (a.queue_id, v_device, a.id, p_state, v_sms_id, v_error, v_metadata, v_now);
  return enrollment_sms_private.attempt_receipt(a);
end;
$$;

create function public.device_mark_sms_sent(
  p_device_token text, p_queue_id uuid, p_attempt_id uuid, p_outcome_event_id uuid,
  p_sms_message_id text default null, p_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql security definer set search_path = '' as $$
  select enrollment_sms_private.finish_attempt(p_device_token, p_queue_id, p_attempt_id,
    p_outcome_event_id, 'sent', p_sms_message_id, null, p_metadata);
$$;
create function public.device_mark_sms_failed(
  p_device_token text, p_queue_id uuid, p_attempt_id uuid, p_outcome_event_id uuid,
  p_error text, p_metadata jsonb default '{}'::jsonb
)
returns jsonb language sql security definer set search_path = '' as $$
  select enrollment_sms_private.finish_attempt(p_device_token, p_queue_id, p_attempt_id,
    p_outcome_event_id, 'failed', null, p_error, p_metadata);
$$;

-- Administrative primitive, not a scheduled job. Claim/begin also reconcile
-- their own device. Nothing here requeues sending or unknown attempts.
create function public.recover_sms_attempts(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_device uuid; v_count integer := 0;
begin
  for v_device in
    select d.id from public.sms_devices d where exists (
      select 1 from public.sms_send_attempts a where a.device_id = d.id
      and ((a.state = 'claimed' and a.claim_expires_at <= clock_timestamp())
        or (a.state = 'sending' and a.outcome_due_at <= clock_timestamp())))
    order by d.id limit greatest(1, least(coalesce(p_limit, 100), 1000)) for update of d skip locked
  loop
    perform enrollment_sms_private.reconcile_device(v_device);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on all functions in schema enrollment_sms_private from public, anon, authenticated, service_role;
revoke all on function public.device_claim_sms_queue(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.device_begin_sms_attempt(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.device_mark_sms_sent(text, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.device_mark_sms_failed(text, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.recover_sms_attempts(integer) from public, anon, authenticated, service_role;
grant execute on function public.device_claim_sms_queue(text, uuid), public.device_begin_sms_attempt(text, uuid),
  public.device_mark_sms_sent(text, uuid, uuid, uuid, text, jsonb),
  public.device_mark_sms_failed(text, uuid, uuid, uuid, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.recover_sms_attempts(integer) to service_role;

notify pgrst, 'reload schema';
commit;
