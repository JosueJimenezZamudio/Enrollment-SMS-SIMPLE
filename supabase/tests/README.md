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
