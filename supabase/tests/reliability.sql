-- Run only against a disposable test database with both migrations applied.
-- All fixtures and helper objects roll back. No SMS transport is involved.
begin;
create temporary table phase1_results (name text primary key);
create function pg_temp.check(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_name; end if;
  insert into phase1_results values (p_name);
end;
$$;
create function pg_temp.throws(p_sql text, p_state text, p_name text) returns void language plpgsql as $$
declare caught boolean := false;
begin
  begin execute p_sql;
  exception when others then
    if sqlstate <> p_state then raise exception 'FAIL: %, expected %, got %: %', p_name, p_state, sqlstate, sqlerrm; end if;
    caught := true;
  end;
  perform pg_temp.check(caught, p_name);
end;
$$;

-- Explicit opt-in: do not run in a database with existing messages/devices.
do $$ begin
  if exists (select 1 from public.sms_queue) or exists (select 1 from public.sms_devices) then
    raise exception 'Tests require an empty disposable database';
  end if;
end $$;

insert into public.sms_devices(id, name, token_hash) values
 ('10000000-0000-0000-0000-000000000001', 'PHASE1 TEST A', public.hash_sms_device_token('phase1-test-device-a')),
 ('10000000-0000-0000-0000-000000000002', 'PHASE1 TEST B', public.hash_sms_device_token('phase1-test-device-b'));

-- Exercise the actual anonymous RPC role, not just owner privileges.
set local role anon;
do $$ begin
  if public.device_claim_sms_queue('phase1-test-device-b','20000000-0000-0000-0000-000000000099')->>'result' <> 'empty' then
    raise exception 'anon RPC failed';
  end if;
  begin
    perform 1 from public.sms_send_attempts;
    raise exception 'anon unexpectedly read attempts';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.create_sms_device('unauthorized device');
    raise exception 'anon unexpectedly provisioned a device';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select pg_temp.check(true, 'anon can call authenticated-by-token RPC but cannot read tables or provision devices');
select pg_temp.check(not has_function_privilege('authenticated','public.create_sms_device(text,text)','EXECUTE'), 'authenticated role cannot provision devices');
do $$ declare d record; begin
  select * into d from public.create_sms_device('PHASE1 temporary provisioning test');
  if length(d.device_token) <> 64 or not exists (select 1 from public.sms_devices
      where id = d.device_id and token_hash = public.hash_sms_device_token(d.device_token)) then
    raise exception 'pgcrypto provisioning/hash mismatch';
  end if;
  delete from public.sms_devices where id = d.device_id;
end $$;
select pg_temp.check(true, 'device provisioning and hashing work with actual pgcrypto schema');
select pg_temp.check(to_regprocedure('public.device_claim_sms_queue(text,integer)') is null, 'legacy batch claim removed');
select pg_temp.check(to_regprocedure('public.device_mark_sms_sent(text,uuid,text,jsonb)') is null, 'legacy sent RPC removed');
select pg_temp.check(to_regprocedure('public.device_mark_sms_failed(text,uuid,text,jsonb)') is null, 'legacy failed RPC removed');
select pg_temp.check(not has_table_privilege('anon','public.sms_send_attempts','SELECT')
  and not has_table_privilege('authenticated','public.sms_send_attempts','UPDATE')
  and not has_table_privilege('anon','public.sms_claim_requests','SELECT'), 'device roles cannot access new tables');
select pg_temp.check((select bool_and(relrowsecurity) from pg_class
  where oid in ('public.sms_send_attempts'::regclass,'public.sms_claim_requests'::regclass)), 'RLS enabled');
select pg_temp.check(not has_schema_privilege('anon','enrollment_sms_private','USAGE')
  and not has_function_privilege('anon','public.recover_sms_attempts(integer)','EXECUTE'), 'private helpers and recovery not public');
select pg_temp.check(has_function_privilege('anon','public.device_begin_sms_attempt(text,uuid)','EXECUTE'), 'device RPC grant exists');
select pg_temp.throws($q$select public.device_claim_sms_queue('invalid',gen_random_uuid())$q$, 'P0001', 'invalid device rejected');
select pg_temp.throws($q$select public.device_claim_sms_queue('phase1-test-device-a',null)$q$, '22023', 'null request ID rejected');

-- Empty responses are durable. A new message must not change a prior result.
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000001')->>'result' = 'empty', 'empty claim recorded');
insert into public.sms_queue(id,to_phone,body,scheduled_at) values
 ('30000000-0000-0000-0000-000000000001','+12025550123','Phase 1 test',clock_timestamp() - interval '1 minute'),
 ('30000000-0000-0000-0000-000000000002','+12025550123','Phase 1 test 2',clock_timestamp() - interval '30 seconds'),
 ('30000000-0000-0000-0000-000000000003','+12025550123','Future test',clock_timestamp() + interval '1 day');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000001')->>'result' = 'empty', 'empty replay does not claim new work');

create temporary table fixture as select public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000002') as receipt;
select pg_temp.check((select receipt->>'result' = 'claimed' from fixture), 'first claim succeeds');
select pg_temp.check((select count(*) = 1 from public.sms_send_attempts), 'claim creates exactly one attempt');
select pg_temp.check((select count(*) = 1 from public.sms_queue where status = 'claimed'), 'claim reserves only one message');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000002') = (select receipt from fixture), 'duplicate claim returns identical reservation');
select pg_temp.check((select attempts = 1 from public.sms_queue where id = '30000000-0000-0000-0000-000000000001'), 'duplicate claim does not increment attempts');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000003')->>'result' = 'busy', 'different request cannot bypass active-device limit');

select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from fixture),gen_random_uuid()), '55000','sent requires begin authorization');
select pg_temp.throws(format('select public.device_begin_sms_attempt(%L,%L)', 'phase1-test-device-b',
 (select receipt->>'attempt_id' from fixture)), '42501','wrong device cannot begin');

-- Expire an unstarted attempt. Move both timestamps to preserve constraints.
update public.sms_send_attempts set claimed_at = clock_timestamp() - interval '3 minutes',
 claim_expires_at = clock_timestamp() - interval '1 minute';
select pg_temp.check(public.device_begin_sms_attempt('phase1-test-device-a',(select (receipt->>'attempt_id')::uuid from fixture))->>'state' = 'expired', 'late begin is fenced and commits expiry');
select pg_temp.check((select status = 'queued' and current_attempt_id is null from public.sms_queue where id = '30000000-0000-0000-0000-000000000001'), 'expired unstarted claim requeued safely');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000002')->>'result' = 'expired', 'old request never revives expired attempt');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000003')->>'result' = 'busy', 'busy receipt remains stable after expiry');
create temporary table current_fixture as select public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000004') as receipt;
select pg_temp.check((select receipt->>'attempt_id' from current_fixture) <> (select receipt->>'attempt_id' from fixture), 'reclaim creates a new attempt ID');
select pg_temp.throws(format('select public.device_mark_sms_failed(%L,%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from fixture),gen_random_uuid(),'old failure'), '55000','expired attempt cannot alter replacement');

create temporary table begin_receipt as select public.device_begin_sms_attempt('phase1-test-device-a',(select (receipt->>'attempt_id')::uuid from current_fixture)) as receipt;
select pg_temp.check((select receipt->>'state' = 'sending' from begin_receipt), 'begin authorizes sending');
select pg_temp.check(public.device_begin_sms_attempt('phase1-test-device-a',(select (receipt->>'attempt_id')::uuid from current_fixture)) = (select receipt from begin_receipt), 'repeated begin preserves authorization and deadline');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a','20000000-0000-0000-0000-000000000004')->>'message' is null, 'sending claim replay does not return send payload');

update public.sms_send_attempts set send_authorized_at = clock_timestamp() - interval '6 minutes', outcome_due_at = clock_timestamp() - interval '1 minute' where state = 'sending';
select public.recover_sms_attempts();
select pg_temp.check((select state = 'unknown' from public.sms_send_attempts where id = (select (receipt->>'attempt_id')::uuid from current_fixture)), 'timed-out authorized attempt becomes unknown');
select pg_temp.check((select status = 'unknown' from public.sms_queue where id = '30000000-0000-0000-0000-000000000001'), 'unknown attempt is never requeued');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a',gen_random_uuid())->>'result' = 'busy', 'unknown pauses further claims');
select pg_temp.check(public.device_begin_sms_attempt('phase1-test-device-a',(select (receipt->>'attempt_id')::uuid from current_fixture))->>'state' = 'unknown', 'begin never reauthorizes unknown');
select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L)', 'phase1-test-device-b',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from current_fixture),gen_random_uuid()), '42501','wrong device cannot report success');
select pg_temp.throws(format('select public.device_mark_sms_failed(%L,%L,%L,%L,%L)', 'phase1-test-device-b',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from current_fixture),gen_random_uuid(),'failure'), '42501','wrong device cannot report failure');
select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000002',(select receipt->>'attempt_id' from current_fixture),gen_random_uuid()), '22023','wrong queue rejected');

create temporary table completion as select public.device_mark_sms_sent('phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select (receipt->>'attempt_id')::uuid from current_fixture),
 '40000000-0000-0000-0000-000000000001','test-callback','{"result":-1}') as receipt;
select pg_temp.check((select receipt->>'state' = 'sent' from completion), 'late success resolves unknown');
select pg_temp.check(public.device_mark_sms_sent('phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select (receipt->>'attempt_id')::uuid from current_fixture),
 '40000000-0000-0000-0000-000000000001','test-callback','{"result":-1}') = (select receipt from completion), 'lost ACK replay returns identical terminal receipt');
select pg_temp.check((select count(*) = 1 from public.sms_send_log), 'repeated success creates one log');
select pg_temp.throws(format('select public.device_mark_sms_failed(%L,%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from current_fixture),
 '40000000-0000-0000-0000-000000000001','conflict'), '23514','opposite terminal outcome rejected');
select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from current_fixture),gen_random_uuid()), '23514','changed outcome event rejected');
select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000001',(select receipt->>'attempt_id' from current_fixture),
 '40000000-0000-0000-0000-000000000001','test-callback','{"result":0}'), '23514','mutated outcome payload rejected');
select pg_temp.check((select status = 'sent' from public.sms_queue where id = '30000000-0000-0000-0000-000000000001') and (select count(*) = 1 from public.sms_send_log), 'conflicts leave accepted outcome and log unchanged');

-- A preflight failure is terminal without granting send authorization.
update current_fixture set receipt = public.device_claim_sms_queue('phase1-test-device-a',gen_random_uuid());
update completion set receipt = public.device_mark_sms_failed('phase1-test-device-a',
 '30000000-0000-0000-0000-000000000002',(select (receipt->>'attempt_id')::uuid from current_fixture),
 '40000000-0000-0000-0000-000000000002','Preflight: multipart');
select pg_temp.check(public.device_mark_sms_failed('phase1-test-device-a',
 '30000000-0000-0000-0000-000000000002',(select (receipt->>'attempt_id')::uuid from current_fixture),
 '40000000-0000-0000-0000-000000000002','Preflight: multipart') = (select receipt from completion), 'repeated failure returns identical receipt');
select pg_temp.check((select count(*) = 2 from public.sms_send_log), 'repeated failure creates one additional log');
select pg_temp.throws(format('select public.device_mark_sms_sent(%L,%L,%L,%L)', 'phase1-test-device-a',
 '30000000-0000-0000-0000-000000000002',(select receipt->>'attempt_id' from current_fixture),
 '40000000-0000-0000-0000-000000000002'), '23514','success cannot overwrite failed outcome');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a',gen_random_uuid())->>'result' = 'empty', 'future scheduled item not claimed');

-- Legacy unknown rows have no safe attempt identity and block their owner.
insert into public.sms_queue(to_phone,body,status,claimed_by) values
 ('+12025550123','Legacy fixture','unknown','10000000-0000-0000-0000-000000000001');
select pg_temp.check(public.device_claim_sms_queue('phase1-test-device-a',gen_random_uuid())->>'result' = 'busy', 'legacy unknown quarantines device');
update public.sms_devices set enabled = false where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.throws($q$select public.device_claim_sms_queue('phase1-test-device-a',gen_random_uuid())$q$, 'P0001','disabled device rejected');
select count(*) as passed_checks, array_agg(name order by name) as checks from phase1_results;
rollback;
