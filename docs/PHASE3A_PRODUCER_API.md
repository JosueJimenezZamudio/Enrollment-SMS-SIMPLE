# Phase 3A: frozen ingest receipts and scoped status reads

Implemented on `reliability-phase-3a` from merged `main`
`d27be2f49bcb69d2a5a99db911a5bf5a3bd7f670`. This is backend/API work only.
No Sheet, Apps Script implementation, Android behavior or device RPC was changed.
No new real SMS is authorized. Keep the gateway stopped.

## Deployment status

As of 2026-10-13, **not deployed to the public schema or Edge runtime**. The dedicated
project has the three Phase 1 migrations and its original successful physical-test
row/attempt/log. Phase 3A SQL was exercised in isolated test schemas, then removed.
Temporary setup/cleanup migration-history entries were removed after verifying
those schemas were gone; the deployed history remains aligned to Phase 1.

## Auth and scope

| Endpoint | POST path | Server secret |
| --- | --- | --- |
| Ingest | `/functions/v1/queue-enrollment-sms` | `LEAD_SMS_INGEST_SECRET` (existing) |
| Status | `/functions/v1/sms-queue-status` | `LEAD_SMS_STATUS_SECRET` (new, distinct value) |

Both use `x-enrollment-sms-secret` as the request header. The separate read credential
allows a status-only worker to reconcile rows without authority to enqueue messages.
There is no fallback from the read secret to the ingest secret. Missing/wrong secrets
return 401 before database access. Configure different, long random secret values.

`SMS_INGEST_CLIENT_ID` binds both endpoints to one server-managed
`sms_ingest_clients` row. Its `device_id` binds new messages to the approved handset.
A request cannot supply a client, device, token, source scope or table name. The
current pair of functions serves one trusted worker; multiple independently scoped
workers would need a future authenticated credential-to-client mapping, not a
client ID in a Sheet cell.

Both RPCs are SECURITY INVOKER and executable only by `service_role`. RLS is enabled
and `anon`/`authenticated` have no table access or RPC execution grants. The Edge
Function alone holds Supabase's service-role credential. Apps Script receives only
the endpoint secrets. Supabase API/publishable keys alone do not authorize these APIs.
The committed function config disables JWT verification only for these two functions
because they implement this custom authentication.

The server role has SELECT and UPDATE(enabled) on clients: PostgreSQL needs an UPDATE
column privilege for the shared row lock that fences concurrent configuration edits.
No API exposes that update. Receipts permit SELECT/INSERT, not UPDATE/DELETE, to the
Edge role. Administrative SQL remains trusted; never prune or rewrite receipts while
submission identities can be retried. They contain sensitive frozen phone/text data.

## Ingest request and canonical payload

```json
{
  "phone": "+12025550123",
  "message": "Literal text frozen from an approved Sheet cell or template.",
  "leadId": "example-lead",
  "eventType": "example-event",
  "dedupeKey": "source:event:instance:example-lead:sms",
  "scheduledAt": "2099-01-01T00:00:00Z"
}
```

This is a contract example, not a request to enqueue it. The six supported fields
are allowlisted; unknown fields, including routing overrides, return 400.

- Phone is a string normalized to US `+1` plus ten digits, as before.
- Message is a string, trimmed as before, nonempty, GSM-7 and at most 160 septets.
  Extension characters cost two septets. No truncation, multipart or template rendering.
- `dedupeKey` is now required: a nonblank string of at most 200 characters. It is
  case-sensitive and otherwise preserved literally. A key identifies a logical send.
- Optional `leadId` and `eventType` are strings of at most 200 characters or null.
  Omitted/null are equivalent; empty strings are distinct from null.
- Optional `scheduledAt` is ISO date/time with explicit `Z` or offset, seconds and
  at most three fractional digits. Invalid calendar days and local/no-offset times
  are rejected. Equivalent timezone representations normalize to the same UTC instant.
- Omitted/null schedule is an explicit **send when available** intent. Its receipt
  stores null; the queue gets the database time exactly once. Retrying null never
  recomputes a material schedule. Supplying that resolved time later is a different
  intent and conflicts. Future Sheet workers should freeze one explicit UTC timestamp
  before the first HTTP request and reuse it.

The immutable JSONB snapshot covers normalized phone, trimmed literal message,
lead ID, event type, schedule intent and server routing device. Exact JSONB equality
avoids a hash-collision or serialization-order ambiguity. Event instance/source
identity belongs in the stable dedupe key for this version; additional unsupported
correlation fields are rejected rather than silently discarded.

## Atomic dedupe and responses

`producer_enqueue_sms(p_client_id, p_dedupe_key, p_phone, p_message,
p_lead_id default null, p_event_type default null, p_scheduled_at default null)`
is the server-only SQL entrypoint. It locks the client row, takes a transaction
advisory lock on the global key, compares an existing receipt or inserts the queue
and receipt in the same transaction. The existing queue unique key remains intact.
Hash collisions in the advisory lock only serialize extra work, never equate payloads.

| Result | HTTP | Meaning |
| --- | --- | --- |
| New valid submission | 201 | One queue and one receipt atomically persisted |
| Same client/key/frozen payload | 200 | Existing queue ID and **current** state; no new row/attempt |
| Same key/different material payload or client | 409 `DEDUPE_CONFLICT` | No overwrite, insertion or disclosure of another receipt |
| Invalid payload | 400 | Correct draft after reconciling any earlier uncertain acceptance |
| Missing/wrong endpoint secret | 401 | Fix credentials; do not allocate a new key |
| Disabled/missing client or disabled device for a new submission | 503 | Operator configuration action required |
| Backend/network/invalid RPC response | 503 | Acceptance may be uncertain; reconcile/retry same frozen identity |

Successful shape (both ingest and status):

```json
{
  "ok": true,
  "duplicate": false,
  "dedupeKey": "source:event:instance:example-lead:sms",
  "queued": {
    "id": "00000000-0000-0000-0000-000000000001",
    "dedupe_key": "source:event:instance:example-lead:sms",
    "status": "queued",
    "scheduled_at": "2099-01-01T00:00:00+00:00",
    "claimed_at": null,
    "sent_at": null,
    "failed_at": null,
    "last_error": null,
    "attempt_status": null
  }
}
```

`duplicate` and top-level `dedupeKey` are ingest-only. Status returns `ok` and
`queued`. The existing `queued.id/status/scheduled_at` receipt shape is preserved
and extended. Duplicate responses now include that receipt instead of just a boolean.
A terminal/unknown queue remains the same logical message on an identical retry.
No ingest or status operation invokes claim, begin, recovery or terminal device RPCs.

Legacy/manual queue items without a producer receipt are not automatically adopted.
A key collision with one returns 409 even if visible content matches: original
schedule intent and producer ownership cannot be proven. Status lookup returns 404.
The original physical-test evidence is intentionally outside this producer scope.

## Minimal status endpoint

POST either `{"queueId":"<uuid>"}`, `{"dedupeKey":"<key>"}`, or both. Both selectors
must match the same owned item; they are ANDed. Exactly one item is returned, with
no listing, batch scan or user-controlled projection. Missing, unowned, mismatched,
legacy and disabled-client lookups all return 404. Missing/invalid selectors return
400. This smaller single-item contract replaces the design's proposed batch endpoint;
a future bounded worker can issue individual reads without broadening data access.

The nine fields inside `queued` are an explicit SQL and HTTP allowlist. No phone,
message, lead ID, metadata, device ID/token, attempt ID, service key or raw exception
is exposed. `last_error` is null when there is none; otherwise it is the safe text
`SMS transport reported an error; operator review required`. Original diagnostics
remain server-side because callbacks can contain sensitive values.

`status` is queued/claimed/sending/unknown/sent/failed/cancelled. `attempt_status`
is the current attempt state, or null when absent (including a legacy unknown).
Attempt states can additionally include expired. A sending attempt may have reached
Android; unknown is quarantined and never authorizes a retry. Sent means Android's
send callback succeeded, not delivery/read or exact local journal acknowledgment.
Status is an observation at query time; later transitions can occur immediately.
Responses specify `Cache-Control: no-store`.

## Cutover procedure (not executed by this PR)

1. Keep gateways stopped and submission producers paused. Review this PR and its
   validation record. Confirm current project and deployed migration history.
2. Apply only `20261013023711_producer_ingest_receipts.sql` to the dedicated project.
   Do not replay/rewrite the three deployed Phase 1 migrations.
3. As the database administrator, create a disabled producer binding using the
   verified Enrollment handset's existing backend identity (not a new device token):

   ```sql
   insert into public.sms_ingest_clients(id, device_id, enabled)
   values ('enrollment-sheet-worker', '<verified-enrollment-device-uuid>', false);
   ```

4. Configure server secrets `LEAD_SMS_INGEST_SECRET`, a distinct
   `LEAD_SMS_STATUS_SECRET`, and `SMS_INGEST_CLIENT_ID=enrollment-sheet-worker`.
   Use the Supabase secret manager/private environment file, not committed files or
   literal credentials in shell history. `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are server-side runtime configuration.
5. Deploy `queue-enrollment-sms` and `sms-queue-status` with this repository's custom
   auth config. Test missing/wrong secrets and a nonexistent status lookup first.
   A correctly authenticated status query for an unknown UUID should return 404.
6. Before enabling a producer, verify approved handset routing, distinct secrets,
   one stable key and frozen schedule per submission, and safe retry/writeback logic.
   Enable the binding only as part of a separately authorized rollout. No Sheet or
   Apps Script trigger is installed in Phase 3A.
7. For any smoke test that inserts rows, use an isolated test project/schema and
   non-routable fixtures. Real phone sessions/messages require new authorization.

The old Apps Script helper remains untouched and is not a ready production worker.
It computes a fresh default schedule on each invocation. A caller must freeze and
pass `scheduledAt` on retries or it will now receive 409. Do not enable the old
hardcoded test helper as a Sheet integration.

For containment: disable the producer binding to reject new ingestion/reads, pause
producers, and stop the handset session if needed. Disabling the producer does not
cancel already accepted messages; it is not a send kill switch. Preserve receipts,
queue items and unknown attempts. Do not roll back to the old blind-duplicate ingest
or drop receipt tables to resolve a conflict. Existing device reporting can continue.

## Validation

See [test commands](../supabase/tests/README.md). Results on 2026-10-13:

- 41 handler tests passed: auth, invalid input/calendar dates, GSM-7 boundaries,
  canonicalization, all states, same/different payload response handling, selectors,
  projection and error sanitization.
- One loopback HTTP integration test passed through the actual runtime handler and
  pinned Supabase JS RPC client against a fake PostgREST server. It verifies RPC
  argument names, server-only credentials, distinct endpoint secrets and projection.
- 65 actual PostgreSQL checks passed in a rollback-only isolated schema, including
  service-role invocation, all state/attempt projections, conflicts for every material
  field, routing, timezone equivalence, ownership and SQL grants.
- Three two-session PostgreSQL concurrency scenarios passed: identical submissions,
  conflicting payloads, and competing clients. Each produced one queue/receipt;
  duplicate IDs matched and conflicts revealed no receipt. Isolated schemas and their
  temporary setup/cleanup history were removed afterward.
- Type checking, formatting, lint and `git diff --check` passed. Existing device
  SQL, Android and Apps Script files are unchanged. No SMS was sent.

The local PostgreSQL build completed but sandbox IPC blocked startup. SQL verification
therefore used Supabase PostgreSQL in isolated schemas, not the live application tables.
The HTTP integration uses a fake database API; deployed Edge-to-PostgREST smoke checks
remain a rollout step because neither public Phase 3A RPCs nor endpoints are deployed.

Security/performance advisors were run while test schema objects existed. New producer
tables have intentional [default-deny RLS without client policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
There were no missing-FK-index or new producer-definer warnings. Existing token-auth
[device RPC warnings](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
remain documented in Phase 1. A no-PK notice concerned only the disposable race-result
collector; unused-index information on synthetic fixtures does not justify removing
production indexes. After teardown, the performance advisor returned no findings.
Run advisors again on actual deployment.
