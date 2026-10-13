-- Rollback-only. Synthetic fixtures cannot be claimed outside this transaction.
begin;
create temporary table producer_test_checks(label text);
create function pg_temp.check_true(value boolean, label text) returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception 'FAILED: %', label; end if;
  insert into producer_test_checks values(label);
end $$;
grant all on producer_test_checks to service_role, anon, authenticated;
insert into public.sms_devices(id,name,token_hash) values
 ('93000000-0000-0000-0000-000000000001','PHASE3 synthetic','phase3-test-hash-1'),
 ('93000000-0000-0000-0000-000000000002','PHASE3 synthetic other','phase3-test-hash-2');
insert into public.sms_ingest_clients(id,device_id,enabled) values
 ('phase3-test','93000000-0000-0000-0000-000000000001',true),
 ('phase3-other','93000000-0000-0000-0000-000000000002',true),
 ('phase3-disabled','93000000-0000-0000-0000-000000000002',false);
set local role service_role;
do $$
declare first jsonb; again jsonb; q uuid; test_state text; a uuid; result jsonb; changed jsonb; base jsonb;
begin
 first := public.producer_enqueue_sms('phase3-test','phase3-key','+12025550123','Frozen text','lead','event',null);
 q := (first->'queued'->>'id')::uuid;
 perform pg_temp.check_true(first->>'result'='created','created');
 again := public.producer_enqueue_sms('phase3-test','phase3-key','+12025550123','Frozen text','lead','event',null);
 perform pg_temp.check_true(again->>'result'='duplicate' and again->'queued'=first->'queued','same payload receipt');
 perform pg_temp.check_true((select count(*)=1 from public.sms_queue where dedupe_key='phase3-key'),'one queue row');
 perform pg_temp.check_true((select device_id='93000000-0000-0000-0000-000000000001'::uuid from public.sms_queue where id=q),'server-bound handset');
 base := jsonb_build_object('phone','+12025550123','message','Frozen text','lead','lead','event','event','schedule',null);
 for changed in select value from jsonb_array_elements(jsonb_build_array(
   base || '{"phone":"+12025550124"}', base || '{"message":"Changed"}',
   base || '{"lead":"other"}', base || '{"event":"other"}', base || '{"schedule":"2099-01-01T00:00:00Z"}'
 )) loop
   result := public.producer_enqueue_sms('phase3-test','phase3-key',changed->>'phone',changed->>'message',changed->>'lead',changed->>'event',(changed->>'schedule')::timestamptz);
   perform pg_temp.check_true(result='{"result":"conflict"}'::jsonb,'material payload conflict');
 end loop;
 perform pg_temp.check_true(public.producer_enqueue_sms('phase3-other','phase3-key','+12025550123','Frozen text','lead','event',null)='{"result":"conflict"}'::jsonb,'other client collision no receipt');
 perform pg_temp.check_true(public.producer_sms_status('phase3-other',q) is null,'ownership read denied');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test',gen_random_uuid()) is null,'nonexistent queue');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test',null,'absent') is null,'nonexistent key');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test',q,'wrong') is null,'selectors intersect');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test') is null,'no listing');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test',null,'phase3-key')=first->'queued','dedupe lookup');
 perform pg_temp.check_true(public.producer_enqueue_sms('phase3-disabled','phase3-disabled-key','+12025550123','Frozen text')->>'result'='client_unavailable','disabled client');
 perform pg_temp.check_true(public.producer_enqueue_sms('absent','phase3-absent-key','+12025550123','Frozen text')->>'result'='client_unavailable','missing client');
 insert into public.sms_queue(to_phone,body,dedupe_key) values('+12025550123','Legacy','phase3-legacy');
 perform pg_temp.check_true(public.producer_enqueue_sms('phase3-test','phase3-legacy','+12025550123','Legacy')->>'result'='conflict','legacy fails closed');
 perform pg_temp.check_true(public.producer_sms_status('phase3-test',null,'phase3-legacy') is null,'legacy status not exposed');
 first := public.producer_enqueue_sms('phase3-test','phase3-time','+12025550123','Scheduled',null,null,'2099-01-01T00:00:00Z');
 again := public.producer_enqueue_sms('phase3-test','phase3-time','+12025550123','Scheduled',null,null,'2098-12-31T16:00:00-08:00');
 perform pg_temp.check_true(again->>'result'='duplicate' and again->'queued'=first->'queued','equivalent timezone instant');
 -- Exercise every queue state and actual current-attempt projection, without transport calls.
 execute 'reset role';
 foreach test_state in array array['queued','claimed','sending','unknown','sent','failed','cancelled'] loop
   if test_state <> 'queued' then
     a := gen_random_uuid();
     insert into public.sms_send_attempts(id,queue_id,device_id,claim_request_id,state,claimed_at,claim_expires_at,
       send_authorized_at,outcome_due_at,outcome_event_id,completed_at)
     values(a,q,'93000000-0000-0000-0000-000000000001',gen_random_uuid(),test_state,now(),now()+interval '2 minutes',
       case when test_state in ('sending','unknown','sent') then now() end,
       case when test_state in ('sending','unknown','sent') then now()+interval '5 minutes' end,
       case when test_state in ('sent','failed') then gen_random_uuid() end,
       case when test_state in ('sent','failed','cancelled') then now() end);
   else a := null; end if;
   update public.sms_queue set status=test_state,current_attempt_id=a,
     claimed_at=case when a is not null then now() end,
     sent_at=case when test_state='sent' then now() end,
     failed_at=case when test_state='failed' then now() end,
     last_error=case when test_state in ('failed','unknown') then 'Sensitive original error' end where id=q;
   execute 'set local role service_role';
   result := public.producer_sms_status('phase3-test',q);
   perform pg_temp.check_true(result->>'status'=test_state and
     (result->>'attempt_status') is not distinct from (case when a is null then null else test_state end),'state '||test_state);
   perform pg_temp.check_true((result->>'sent_at' is not null)=(test_state='sent') and (result->>'failed_at' is not null)=(test_state='failed'),'timestamps '||test_state);
   perform pg_temp.check_true((select array_agg(k order by k) from jsonb_object_keys(result) k)=array['attempt_status','claimed_at','dedupe_key','failed_at','id','last_error','scheduled_at','sent_at','status'],'minimal projection '||test_state);
   perform pg_temp.check_true(result::text not like '%Sensitive original error%','sanitized diagnostic '||test_state);
   again := public.producer_enqueue_sms('phase3-test','phase3-key','+12025550123','Frozen text','lead','event',null);
   perform pg_temp.check_true(again->>'result'='duplicate' and again->'queued'=result,'duplicate returns current '||test_state);
   execute 'reset role';
   update public.sms_queue set status='queued',current_attempt_id=null where id=q;
   update public.sms_send_attempts set state='expired', send_authorized_at=null, outcome_due_at=null, outcome_event_id=null, completed_at=now() where id=a;
 end loop;
 perform pg_temp.check_true((select count(*)=1 from public.sms_queue where dedupe_key='phase3-key'),'no terminal re-enqueue');
end $$;
reset role;
-- A changed server routing binding is material too; it cannot move an accepted message.
update public.sms_ingest_clients set device_id='93000000-0000-0000-0000-000000000002' where id='phase3-test';
select pg_temp.check_true(public.producer_enqueue_sms('phase3-test','phase3-key','+12025550123','Frozen text','lead','event',null)->>'result'='conflict','routing conflict');
update public.sms_ingest_clients set enabled=false where id='phase3-test';
select pg_temp.check_true(public.producer_sms_status('phase3-test',null,'phase3-key') is null,'disabled reads denied');
set local role anon;
do $$ begin
 begin
   perform public.producer_sms_status('phase3-other',null,'phase3-key');
   raise exception 'anonymous read permitted';
 exception when insufficient_privilege then perform pg_temp.check_true(true,'anon RPC blocked'); end;
 begin
   perform public.producer_enqueue_sms('phase3-other','anon','+12025550123','No');
   raise exception 'anonymous ingest permitted';
 exception when insufficient_privilege then perform pg_temp.check_true(true,'anon ingest blocked'); end;
end $$;
reset role;
select pg_temp.check_true(not has_function_privilege('authenticated','public.producer_sms_status(text,uuid,text)','execute'),'authenticated status blocked');
select pg_temp.check_true(not has_function_privilege('authenticated','public.producer_enqueue_sms(text,text,text,text,text,text,timestamptz)','execute'),'authenticated ingest blocked');
select pg_temp.check_true(not has_table_privilege('anon','public.sms_ingest_receipts','select') and not has_table_privilege('authenticated','public.sms_ingest_receipts','select'),'receipt table private');
select pg_temp.check_true(not has_table_privilege('service_role','public.sms_ingest_receipts','update') and not has_table_privilege('service_role','public.sms_ingest_receipts','delete'),'receipts not mutable by Edge role');
select count(*) as passed_producer_checks from producer_test_checks;
rollback;
