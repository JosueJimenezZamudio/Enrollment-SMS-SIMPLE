create extension if not exists pgcrypto;

create table if not exists public.sms_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  token_hash text not null unique,
  enabled boolean not null default true,
  status text not null default 'offline' check (status in ('offline','online','disabled')),
  last_seen_at timestamptz,
  app_version text,
  android_version text,
  manufacturer text,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sms_queue (
  id uuid primary key default gen_random_uuid(),
  lead_id text,
  to_phone text not null,
  body text not null,
  event_type text,
  dedupe_key text unique,
  status text not null default 'queued'
    check (status in ('queued','claimed','sent','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  device_id uuid references public.sms_devices(id) on delete set null,
  claimed_by uuid references public.sms_devices(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sms_queue_claim_idx
  on public.sms_queue(status, scheduled_at, created_at)
  where status = 'queued';

create table if not exists public.sms_send_log (
  id bigint generated always as identity primary key,
  queue_id uuid not null references public.sms_queue(id) on delete cascade,
  device_id uuid references public.sms_devices(id) on delete set null,
  status text not null check (status in ('sent','failed')),
  sms_message_id text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

alter table public.sms_devices enable row level security;
alter table public.sms_queue enable row level security;
alter table public.sms_send_log enable row level security;

revoke all on public.sms_devices from anon, authenticated;
revoke all on public.sms_queue from anon, authenticated;
revoke all on public.sms_send_log from anon, authenticated;

grant select, insert, update, delete on public.sms_devices to service_role;
grant select, insert, update, delete on public.sms_queue to service_role;
grant select, insert, update, delete on public.sms_send_log to service_role;
grant usage, select on sequence public.sms_send_log_id_seq to service_role;

create or replace function public.hash_sms_device_token(p_token text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select encode(digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public.require_sms_device(p_device_token text)
returns public.sms_devices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.sms_devices;
begin
  if nullif(trim(coalesce(p_device_token, '')), '') is null then
    raise exception 'Device token is required';
  end if;

  select *
  into d
  from public.sms_devices
  where token_hash = public.hash_sms_device_token(p_device_token)
    and enabled = true
  limit 1;

  if d.id is null then
    raise exception 'Invalid or disabled device token';
  end if;

  return d;
end;
$$;

create or replace function public.create_sms_device(
  p_name text,
  p_phone text default null
)
returns table(device_id uuid, device_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raw_token text;
  new_id uuid;
begin
  raw_token := encode(gen_random_bytes(32), 'hex');

  insert into public.sms_devices(name, phone, token_hash)
  values (
    nullif(trim(coalesce(p_name, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    public.hash_sms_device_token(raw_token)
  )
  returning id into new_id;

  if new_id is null then
    raise exception 'Device name is required';
  end if;

  return query select new_id, raw_token;
end;
$$;

create or replace function public.device_heartbeat(
  p_device_token text,
  p_app_version text default null,
  p_android_version text default null,
  p_manufacturer text default null,
  p_model text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.sms_devices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.sms_devices;
  updated_device public.sms_devices;
begin
  d := public.require_sms_device(p_device_token);

  update public.sms_devices
  set status = 'online',
      last_seen_at = now(),
      app_version = coalesce(nullif(p_app_version, ''), app_version),
      android_version = coalesce(nullif(p_android_version, ''), android_version),
      manufacturer = coalesce(nullif(p_manufacturer, ''), manufacturer),
      model = coalesce(nullif(p_model, ''), model),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where id = d.id
  returning * into updated_device;

  return updated_device;
end;
$$;

create or replace function public.device_claim_sms_queue(
  p_device_token text,
  p_limit integer default 5
)
returns table(
  id uuid,
  to_phone text,
  body text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.sms_devices;
  safe_limit integer;
begin
  d := public.require_sms_device(p_device_token);
  safe_limit := greatest(1, least(coalesce(p_limit, 5), 10));

  update public.sms_devices
  set status = 'online', last_seen_at = now(), updated_at = now()
  where sms_devices.id = d.id;

  return query
  with candidates as (
    select q.id
    from public.sms_queue q
    where q.status = 'queued'
      and q.scheduled_at <= now()
      and (q.device_id is null or q.device_id = d.id)
    order by q.scheduled_at asc, q.created_at asc
    limit safe_limit
    for update skip locked
  ),
  claimed as (
    update public.sms_queue q
    set status = 'claimed',
        device_id = coalesce(q.device_id, d.id),
        claimed_by = d.id,
        claimed_at = now(),
        attempts = q.attempts + 1,
        updated_at = now()
    from candidates c
    where q.id = c.id
    returning q.id, q.to_phone, q.body, q.metadata
  )
  select claimed.id, claimed.to_phone, claimed.body, claimed.metadata
  from claimed;
end;
$$;

create or replace function public.device_mark_sms_sent(
  p_device_token text,
  p_queue_id uuid,
  p_sms_message_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.sms_queue
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.sms_devices;
  q public.sms_queue;
begin
  d := public.require_sms_device(p_device_token);

  update public.sms_queue
  set status = 'sent',
      sent_at = now(),
      failed_at = null,
      last_error = null,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where id = p_queue_id
    and (device_id = d.id or claimed_by = d.id)
  returning * into q;

  if q.id is null then
    raise exception 'Queue item not found for this device';
  end if;

  insert into public.sms_send_log(queue_id, device_id, status, sms_message_id, metadata)
  values (
    q.id,
    d.id,
    'sent',
    nullif(trim(coalesce(p_sms_message_id, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );

  return q;
end;
$$;

create or replace function public.device_mark_sms_failed(
  p_device_token text,
  p_queue_id uuid,
  p_error text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.sms_queue
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.sms_devices;
  q public.sms_queue;
begin
  d := public.require_sms_device(p_device_token);

  update public.sms_queue
  set status = 'failed',
      failed_at = now(),
      last_error = nullif(trim(coalesce(p_error, '')), ''),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where id = p_queue_id
    and (device_id = d.id or claimed_by = d.id)
  returning * into q;

  if q.id is null then
    raise exception 'Queue item not found for this device';
  end if;

  insert into public.sms_send_log(queue_id, device_id, status, error, metadata)
  values (
    q.id,
    d.id,
    'failed',
    nullif(trim(coalesce(p_error, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  );

  return q;
end;
$$;

revoke all on function public.hash_sms_device_token(text) from public;
revoke all on function public.require_sms_device(text) from public;
revoke all on function public.create_sms_device(text, text) from public;
revoke all on function public.device_heartbeat(text, text, text, text, text, jsonb) from public;
revoke all on function public.device_claim_sms_queue(text, integer) from public;
revoke all on function public.device_mark_sms_sent(text, uuid, text, jsonb) from public;
revoke all on function public.device_mark_sms_failed(text, uuid, text, jsonb) from public;

grant execute on function public.device_heartbeat(text, text, text, text, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.device_claim_sms_queue(text, integer) to anon, authenticated, service_role;
grant execute on function public.device_mark_sms_sent(text, uuid, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.device_mark_sms_failed(text, uuid, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.create_sms_device(text, text) to service_role;
grant execute on function public.hash_sms_device_token(text) to service_role;
grant execute on function public.require_sms_device(text) to service_role;

notify pgrst, 'reload schema';
