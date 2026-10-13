# Database reliability tests

Use a dedicated empty database with Supabase's `anon`, `authenticated`, and
`service_role` roles. No test invokes Android or sends an SMS. Never run these
against a database attached to a live gateway.

Use normal libpq `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`
configuration. Keep credentials out of files and command history.

```sh
# Fresh test database only; existing deployments apply forward migrations instead.
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql

# Sequential checks; all fixtures/helpers roll back.
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/reliability.sql

# Two real sessions; creates narrowly scoped fixtures, verifies, then removes them.
python3 supabase/tests/concurrency.py --empty-test-database

# Migration compatibility tests run in isolated schemas and roll back.
python3 supabase/tests/upgrade.py | psql -X -v ON_ERROR_STOP=1
```

For MCP execution, send `reliability.sql` as one SQL request. For concurrency,
`python3 supabase/tests/concurrency.py --print-json` emits scenario objects. For
each object, execute `setup`, launch both `sessions` SQL strings concurrently in
separate connections, execute `verify`, and always execute `cleanup` afterward.
If setup fails, stop; do not clean up an unrecognized database. The same scenario
SQL is used by the psql driver and MCP validation. A failure in either session is
a test failure, except for the explicitly expected terminal conflict inside its
SQL block. A runner interruption can leave test fixtures; inspect before cleanup.

For `upgrade.py`, send its generated SQL as one MCP request. It verifies upgrade
of populated legacy tables in a separate schema without replacing public tables.

Coverage includes durable duplicate/empty/busy claim receipts, single active
attempts, expiry fencing, fixed begin deadlines, unknown quarantine, late outcomes,
idempotent terminal ACKs, conflicts, device authorization, API-role privileges,
future scheduling, crypto helper compatibility, and competing transactions.

The baseline migration is intentionally unchanged. The fresh-database bootstrap
works around its unqualified pgcrypto function definitions with transaction-local
`check_function_bodies=off`; the forward migration replaces the affected
functions using the extension's actual schema before they are invoked.

## Phase 3A producer API

```sh
# Pure request-handler tests; no database/network permissions.
deno test supabase/tests/producer_api_test.ts
# Runtime and pinned Supabase client over loopback HTTP, fake PostgREST backend.
deno test --allow-env --allow-net=127.0.0.1 supabase/tests/producer_http_test.ts
deno check supabase/functions/queue-enrollment-sms/index.ts supabase/functions/sms-queue-status/index.ts
deno lint supabase/functions supabase/tests/producer_api_test.ts supabase/tests/producer_http_test.ts

# After bootstrap in a disposable DB; all sequential fixtures roll back.
psql -X -v ON_ERROR_STOP=1 -f supabase/tests/producer.sql
# Same migrations/tests in isolated schemas, rolled back; suitable for MCP SQL.
python3 supabase/tests/producer_isolated.py | psql -X -v ON_ERROR_STOP=1
# Two real sessions in private disposable schemas; teardown runs in finally.
python3 supabase/tests/producer_concurrency.py --isolated-test-schemas
```

For an MCP concurrency runner, `producer_concurrency.py --print-json` emits one
`setup`, three `scenarios` (each has two `sessions` and `verify`), and `cleanup`.
Apply fixture DDL through the migration tool, run each pair concurrently, inspect
both results and verify, then remove the isolated schemas. Never proceed after
setup fails or clean up an unrecognized schema. A stopped runner can leave fixtures;
inspect before resuming. Temporary setup/cleanup migration history must be reconciled
after successful teardown so it does not appear as a deployed product migration.
Do not expose these schemas via PostgREST or attach a gateway to them.

Tests exercise the actual SQL using `service_role`, with administrator-only fixture
state changes. No phone calls, SMS sends, token provisioning on physical handsets,
or live queue updates occur. Concurrency fixtures use reserved example numbers,
future schedules and isolated queue tables. `producer.sql` also verifies that
anonymous/authenticated clients cannot execute the producer RPCs or read receipts.

See [Phase 3A validation and limitations](../../docs/PHASE3A_PRODUCER_API.md#validation).
