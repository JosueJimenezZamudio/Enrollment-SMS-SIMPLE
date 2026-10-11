#!/usr/bin/env python3
"""Run SQL scenarios using two real sessions. Requires psql and an EMPTY test DB.
Uses standard PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD environment variables.
--print-json emits the exact same scenarios for an MCP SQL runner.
"""
import concurrent.futures
import json
import subprocess
import sys
import threading

A = '10000000-0000-0000-0000-000000000001'
B = '10000000-0000-0000-0000-000000000002'
Q = '30000000-0000-0000-0000-000000000001'
R = '20000000-0000-0000-0000-000000000001'
E = '40000000-0000-0000-0000-000000000001'
ATTEMPT = f"(select current_attempt_id from public.sms_queue where id='{Q}')"
CLAIM = f"select public.device_claim_sms_queue('phase1-test-device-a','{R}');"
BEGIN = f"select public.device_begin_sms_attempt('phase1-test-device-a',{ATTEMPT});"
SENT = f"select public.device_mark_sms_sent('phase1-test-device-a','{Q}',{ATTEMPT},'{E}','test');"
FAILED = f"select public.device_mark_sms_failed('phase1-test-device-a','{Q}',{ATTEMPT},'{E}','test failure');"
SETUP = f"""
do $$ begin
 if exists(select 1 from public.sms_queue) or exists(select 1 from public.sms_devices) then
   raise exception 'Concurrency tests require an empty disposable database';
 end if;
end $$;
insert into public.sms_devices(id,name,token_hash) values
 ('{A}','PHASE1 TEST A',public.hash_sms_device_token('phase1-test-device-a')),
 ('{B}','PHASE1 TEST B',public.hash_sms_device_token('phase1-test-device-b'));
insert into public.sms_queue(id,to_phone,body) values ('{Q}','+12025550123','Phase1 concurrency fixture');
"""
CLEANUP = f"""
begin;
delete from public.sms_send_log where queue_id='{Q}';
delete from public.sms_claim_requests where device_id in ('{A}','{B}');
update public.sms_queue set current_attempt_id=null,status='queued' where id='{Q}';
delete from public.sms_send_attempts where queue_id='{Q}';
delete from public.sms_queue where id='{Q}';
delete from public.sms_devices where id in ('{A}','{B}') and name in ('PHASE1 TEST A','PHASE1 TEST B');
commit;
"""

def tx(sql):
    return "begin; set local statement_timeout='15s'; " + sql + " select pg_sleep(1); commit;"

def verify(condition):
    return f"do $$ begin if not ({condition}) then raise exception 'Concurrency invariant failed'; end if; end $$; select 'passed' as result;"

def conflict_safe(sql):
    return "do $$ begin " + sql.replace('select public.', 'perform public.') + " exception when check_violation then null; end $$;"

SCENARIOS = [
    dict(name='concurrent duplicate claim', setup=SETUP,
         sessions=[tx(CLAIM), tx(CLAIM)],
         verify=verify("(select count(*)=1 from public.sms_send_attempts) and (select count(*)=1 from public.sms_claim_requests) and (select attempts=1 from public.sms_queue)")),
    dict(name='concurrent different requests same device', setup=SETUP,
         sessions=[tx(CLAIM), tx(CLAIM.replace(R,'20000000-0000-0000-0000-000000000002'))],
         verify=verify("(select count(*)=1 from public.sms_send_attempts) and (select count(*)=1 from public.sms_claim_requests where result='busy')")),
    dict(name='two devices cannot claim same message', setup=SETUP,
         sessions=[tx(CLAIM), tx(CLAIM.replace('phase1-test-device-a','phase1-test-device-b'))],
         verify=verify("(select count(*)=1 from public.sms_send_attempts) and (select count(*)=1 from public.sms_claim_requests where result='empty')")),
    dict(name='concurrent identical terminal reports', setup=SETUP+CLAIM+BEGIN,
         sessions=[tx(SENT),tx(SENT)],
         verify=verify("(select count(*)=1 from public.sms_send_log) and (select status='sent' from public.sms_queue)")),
    dict(name='concurrent conflicting terminal reports', setup=SETUP+CLAIM+BEGIN,
         sessions=[tx(conflict_safe(SENT)), tx(conflict_safe(FAILED))],
         verify=verify("(select count(*)=1 from public.sms_send_log) and (select q.status=a.state and a.state=l.status from public.sms_queue q join public.sms_send_attempts a on a.id=q.current_attempt_id join public.sms_send_log l on l.attempt_id=a.id)")),
    dict(name='stale recovery races late begin', setup=SETUP+CLAIM+"update public.sms_send_attempts set claimed_at=clock_timestamp()-interval '3 minutes',claim_expires_at=clock_timestamp()-interval '1 minute';",
         sessions=[tx('select public.recover_sms_attempts();'),tx(BEGIN)],
         verify=verify("(select state='expired' and send_authorized_at is null from public.sms_send_attempts) and (select status='queued' and current_attempt_id is null from public.sms_queue)")),
    dict(name='authorized attempt survives claim deadline and recovery', setup=SETUP+CLAIM+BEGIN+"update public.sms_send_attempts set claimed_at=clock_timestamp()-interval '3 minutes',claim_expires_at=clock_timestamp()-interval '1 minute';",
         sessions=[tx('select public.recover_sms_attempts();'),tx(BEGIN)],
         verify=verify("(select state='sending' from public.sms_send_attempts) and (select status='sending' from public.sms_queue)")),
]
# Save the old identity before recovery clears the queue pointer.
SCENARIOS[5]['sessions'][1] = tx("select public.device_begin_sms_attempt('phase1-test-device-a',(select id from public.sms_send_attempts));")
for scenario in SCENARIOS:
    scenario['cleanup'] = CLEANUP


def sql(query):
    result = subprocess.run(['psql','-XAt','-v','ON_ERROR_STOP=1'], input=query, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


def main():
    if '--print-json' in sys.argv:
        print(json.dumps(SCENARIOS))
        return
    if '--empty-test-database' not in sys.argv:
        raise SystemExit('Pass --empty-test-database; never run against production.')
    for scenario in SCENARIOS:
        # Setup failure does not invoke cleanup against an unrecognized database.
        sql(scenario['setup'])
        try:
            barrier = threading.Barrier(2)
            def session(query):
                barrier.wait()
                return sql(query)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(session,scenario['sessions']))
            sql(scenario['verify'])
            print('PASS:',scenario['name'])
        finally:
            sql(scenario['cleanup'])


if __name__ == '__main__':
    main()
