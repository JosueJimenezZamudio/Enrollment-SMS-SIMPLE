#!/usr/bin/env python3
"""Two-session producer tests in private, disposable schemas; no public fixtures.
--print-json exposes the same SQL for an MCP runner. Requires bootstrap roles/pgcrypto.
Always clean up a successfully created fixture, including after session failures.
"""
import concurrent.futures
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'sms_phase3_race_test'
PRIVATE = 'sms_phase3_race_private'
def isolated(text):
    text = text.replace('public.', SCHEMA + '.').replace('enrollment_sms_private', PRIVATE)
    return re.sub(r'^(begin|commit|rollback);\s*$', '', text, flags=re.MULTILINE)
setup = f"""begin;
do $$ begin
 if to_regnamespace('{SCHEMA}') is not null or to_regnamespace('{PRIVATE}') is not null then
   raise exception 'Race test schemas already exist; inspect before cleanup';
 end if;
end $$;
create schema {SCHEMA};
grant usage on schema {SCHEMA} to service_role;
set local check_function_bodies=off;
"""
for filename in ['001_enrollment_sms.sql', '20261011232557_sms_send_attempts.sql',
                 '20261011233522_sms_attempt_indexes.sql', '20261013023711_producer_ingest_receipts.sql']:
    setup += isolated((ROOT / 'migrations' / filename).read_text()) + '\n'
setup += f"""
create table {SCHEMA}.race_results(scenario text, result jsonb);
grant insert on {SCHEMA}.race_results to service_role;
insert into {SCHEMA}.sms_devices(id,name,token_hash) values
 ('93000000-0000-0000-0000-000000000001','PHASE3 isolated race','phase3-race-only');
insert into {SCHEMA}.sms_ingest_clients(id,device_id,enabled) values
 ('race-a','93000000-0000-0000-0000-000000000001',true),
 ('race-b','93000000-0000-0000-0000-000000000001',true);
commit;
"""
def session(key, text='Frozen', client='race-a'):
    return f"""begin; set local statement_timeout='30s'; set local role service_role;
insert into {SCHEMA}.race_results values('{key}',{SCHEMA}.producer_enqueue_sms(
 '{client}','{key}','+12025550123','{text}',null,null,'2099-01-01T00:00:00Z'));
select pg_sleep(2); commit;"""
def verify(key, outcome):
    return f"""do $$ begin
 if (select count(*) from {SCHEMA}.sms_queue where dedupe_key='{key}') <> 1
 or (select count(*) from {SCHEMA}.sms_ingest_receipts where dedupe_key='{key}') <> 1
 or (select count(*) from {SCHEMA}.race_results where scenario='{key}' and result->>'result'='created') <> 1
 or (select count(*) from {SCHEMA}.race_results where scenario='{key}' and result->>'result'='{outcome}') <> 1
 then raise exception 'Concurrent producer invariant failed'; end if;
 if '{outcome}'='duplicate' and
   (select count(distinct result->'queued'->>'id') from {SCHEMA}.race_results where scenario='{key}') <> 1
 then raise exception 'Duplicate returned different queue'; end if;
end $$; select '{key}: passed' as result;"""
scenarios = [
 dict(name='same payload',sessions=[session('same'),session('same')],verify=verify('same','duplicate')),
 dict(name='different payload',sessions=[session('different'),session('different','Changed')],verify=verify('different','conflict')),
 dict(name='different client',sessions=[session('ownership'),session('ownership',client='race-b')],verify=verify('ownership','conflict')),
]
cleanup = f'drop schema {SCHEMA} cascade; drop schema {PRIVATE} cascade;'
def sql(query):
    r = subprocess.run(['psql','-XAt','-v','ON_ERROR_STOP=1'], input=query, text=True, capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr)
    return r.stdout
if __name__ == '__main__':
    if '--print-json' in sys.argv:
        print(json.dumps(dict(setup=setup,scenarios=scenarios,cleanup=cleanup)))
    elif '--isolated-test-schemas' in sys.argv:
        sql(setup)
        try:
            for scenario in scenarios:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                    for result in executor.map(sql, scenario['sessions']): pass
                print(sql(scenario['verify']))
        finally: sql(cleanup)
    else:
        sys.exit('Use --isolated-test-schemas or --print-json; never attach a gateway to these schemas.')
