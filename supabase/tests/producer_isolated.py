#!/usr/bin/env python3
"""Emit one rollback-only SQL test for MCP (no live table or migration changes)."""
from pathlib import Path
import re
ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'sms_phase3_validation'
PRIVATE = 'sms_phase3_validation_private'
def isolated(text):
    text = text.replace('public.', SCHEMA + '.').replace('enrollment_sms_private', PRIVATE)
    return re.sub(r'^(begin|commit|rollback);\s*$', '', text, flags=re.MULTILINE)
print(f"""begin;
do $$ begin
 if to_regnamespace('{SCHEMA}') is not null or to_regnamespace('{PRIVATE}') is not null then
   raise exception 'Test schemas already exist';
 end if;
end $$;
create schema {SCHEMA};
grant usage on schema {SCHEMA} to anon, authenticated, service_role;
set local check_function_bodies=off;
""")
for filename in ['001_enrollment_sms.sql','20261011232557_sms_send_attempts.sql',
                 '20261011233522_sms_attempt_indexes.sql','20261013023711_producer_ingest_receipts.sql']:
    print(isolated((ROOT / 'migrations' / filename).read_text()))
print('set local check_function_bodies=on;')
print(isolated((ROOT / 'tests/producer.sql').read_text()))
print('rollback;')
