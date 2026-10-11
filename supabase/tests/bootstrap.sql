-- NEW DISPOSABLE DATABASE ONLY. Never rerun baseline on a deployed database.
\set ON_ERROR_STOP on
begin;
set local check_function_bodies = off;
\ir ../migrations/001_enrollment_sms.sql
commit;
\ir ../migrations/20261011232557_sms_send_attempts.sql
\ir ../migrations/20261011233522_sms_attempt_indexes.sql
