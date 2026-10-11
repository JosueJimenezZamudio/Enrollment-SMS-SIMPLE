#!/usr/bin/env python3
"""Emit a rollback-only populated-baseline upgrade test for psql or MCP."""
from pathlib import Path
import hashlib
import re

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'sms_phase1_upgrade_test'
PRIVATE = 'sms_phase1_upgrade_private'

def isolated(source):
    # Only relocate our schemas; do not change function bodies or state logic.
    source = source.replace('public.', SCHEMA + '.').replace('enrollment_sms_private', PRIVATE)
    return re.sub(r'^(begin|commit);\s*$', '', source, flags=re.MULTILINE)

baseline = (ROOT / 'migrations/001_enrollment_sms.sql').read_text()
phase1 = (ROOT / 'migrations/20261011232557_sms_send_attempts.sql').read_text()
indexes = (ROOT / 'migrations/20261011233522_sms_attempt_indexes.sql').read_text()
fixture_hash = hashlib.sha256(b'phase1-upgrade-test-token').hexdigest()
print(f"""begin;
do $$ begin
 if to_regnamespace('{SCHEMA}') is not null or to_regnamespace('{PRIVATE}') is not null then
  raise exception 'Upgrade test schema already exists';
 end if;
end $$;
create schema {SCHEMA};
set local check_function_bodies = off;
""")
print(isolated(baseline))
print(f"""
insert into {SCHEMA}.sms_devices(id,name,token_hash) values
 ('10000000-0000-0000-0000-000000000001','PHASE1 legacy fixture','{fixture_hash}');
insert into {SCHEMA}.sms_queue(id,to_phone,body,status,device_id,claimed_by,attempts) values
 ('30000000-0000-0000-0000-000000000001','+12025550123','Old claim 1','claimed','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1),
 ('30000000-0000-0000-0000-000000000002','+12025550123','Old claim 2','claimed','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1),
 ('30000000-0000-0000-0000-000000000003','+12025550123','Old sent','sent','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1);
insert into {SCHEMA}.sms_send_log(queue_id,device_id,status,sms_message_id) values
 ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','sent','legacy-log');
set local check_function_bodies = on;
""")
print(isolated(phase1))
print(isolated(indexes))
print(f"""
do $$ begin
 if (select count(*) from {SCHEMA}.sms_queue where status='unknown' and current_attempt_id is null) <> 2 then
   raise exception 'Legacy claims were not quarantined'; end if;
 if (select count(*) from {SCHEMA}.sms_send_attempts) <> 0 then
   raise exception 'Migration fabricated legacy attempts'; end if;
 if (select count(*) from {SCHEMA}.sms_queue where device_id='10000000-0000-0000-0000-000000000001'
     and claimed_by='10000000-0000-0000-0000-000000000001' and attempts=1) <> 3 then
   raise exception 'Historical ownership changed'; end if;
 if (select count(*) from {SCHEMA}.sms_send_log where status='sent' and sms_message_id='legacy-log' and attempt_id is null) <> 1 then
   raise exception 'Legacy log changed'; end if;
 if {SCHEMA}.device_claim_sms_queue('phase1-upgrade-test-token',gen_random_uuid())->>'result' <> 'busy' then
   raise exception 'Old token no longer works or legacy device not blocked'; end if;
 if {SCHEMA}.recover_sms_attempts() <> 0 then
   raise exception 'Recovery touched ambiguous legacy rows'; end if;
 if to_regprocedure('{SCHEMA}.device_claim_sms_queue(text,integer)') is not null then
   raise exception 'Legacy batch API still exists'; end if;
end $$;
select 7 as passed_upgrade_checks;
rollback;
""")
