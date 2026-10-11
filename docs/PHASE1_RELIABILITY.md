# Phase 1: database send-attempt protocol

This phase implements the database half only. **The current Android application
is intentionally incompatible with these mutations.** Do not enable an old
Android gateway against this schema. No Edge Function or Apps Script change is
needed for queue insertion. `device_heartbeat` and device provisioning retain
their signatures.

## Invariants

- One active attempt per message and per device, enforced by partial unique indexes.
- Only `claimed` attempts that never received send authorization may expire back
  to `queued`. Each reclaim creates a new attempt ID.
- `sending` means the device may have submitted the SMS, not that it definitely did.
- A missed outcome deadline changes `sending` to `unknown`; neither state is
  ever automatically requeued. `unknown` continues occupying the device slot.
- Only the owning device can begin or report an attempt, and reports must carry
  both the queue ID and exact attempt ID.
- Repeated identical terminal reports return the original acknowledgment with
  unchanged timestamps and exactly one send-log entry. Conflicts raise an error.
- Database idempotency is not exactly-once SMS delivery. The future Android
  journal must prohibit dispatch replay after its durable dispatch transition.

## Data and states

`sms_send_attempts` stores reservation, authorization, deadlines, terminal event
identity and immutable result data. `sms_queue.current_attempt_id` identifies
its current attempt; a composite foreign key prevents linking another message's
attempt. `sms_claim_requests` stores durable receipts, including empty and busy
results. Do not prune those receipts while callers may replay their IDs.

Queue transitions implemented by this phase:

```text
queued -> claimed -> sending -> sent / failed
             |          |
             |          +-> unknown -> sent / failed (late callback)
             +-> failed (definitive preflight rejection)
             +-> queued (unstarted lease expires; attempt becomes expired)
```

`cancelled` remains a reserved terminal state. This phase adds no cancellation or
manual unknown-resolution RPC. Operators must not edit active queue states,
requeue unknowns, or delete attempts directly. A future administrative resolution
operation must observe the same fencing rules. `sent` is Android send success,
not recipient delivery.

`device_id` on the queue remains an optional routing restriction. Claiming now
records ownership in `claimed_by` and the attempt instead of permanently filling
an initially unassigned `device_id`; safe expired work can move to another device.

## RPC contract

All UUID arguments are required unless explicitly noted. JSONB results are JSON
objects, not the old claim array or queue-row response. Missing/old parameters
fail closed; the legacy overloads are dropped, not left executable.

### `device_claim_sms_queue(p_device_token text, p_claim_request_id uuid)`

Persist a fresh request ID before invoking. A call returns one of:

- `{result: "empty", claim_request_id, attempt_id: null}`
- `{result: "busy", claim_request_id, attempt_id}`; attempt ID can be null for a
  quarantined legacy row.
- An attempt receipt plus `result`, `claim_request_id`, and `message`.
  `message` contains `id`, `to_phone`, `body`, `metadata` only while the attempt
  remains `claimed`. Otherwise it is null.

Claim-request identity is scoped to the device. Repeating a successful request
returns that same attempt's **current state**, never a replacement. Repeating an
empty/busy request always returns its original empty/busy result, even if the
queue changed. To poll again use a new ID. Different IDs do not bypass a device's
active slot. Only due `queued` rows matching the routing restriction are eligible.

An attempt receipt contains:

```text
attempt_id, queue_id, state, claim_expires_at,
send_authorized_at, outcome_due_at, outcome_event_id, completed_at
```

### `device_begin_sms_attempt(p_device_token text, p_attempt_id uuid)`

Returns an attempt receipt. An unexpired current claim becomes `sending` with
fixed authorization and outcome timestamps. Repeating the operation returns
existing state without extending deadlines. An expired claim is reconciled and
returns `expired` rather than raising an exception that would roll back expiry.
`unknown` and terminal states are returned without reauthorizing.

Only the originating Android worker that durably committed dispatch may use its
successful begin response to submit once. A recovered/restarted worker **must
not** interpret an existing `sending` receipt as permission to repeat submission.

### Terminal reports

```text
device_mark_sms_sent(
  p_device_token text, p_queue_id uuid, p_attempt_id uuid,
  p_outcome_event_id uuid, p_sms_message_id text = null,
  p_metadata jsonb = '{}'
)

device_mark_sms_failed(
  p_device_token text, p_queue_id uuid, p_attempt_id uuid,
  p_outcome_event_id uuid, p_error text, p_metadata jsonb = '{}'
)
```

The future client must persist one immutable event ID and outcome payload before
uploading. Retries must preserve the event ID, message/error string and metadata;
do not regenerate `reported_at` for each retry. Blank message/error strings are
normalized to null. Metadata must be a JSON object; SQL null becomes `{}`.

Both RPCs accept `sending` and `unknown`. Failure also accepts an unexpired
`claimed` attempt for a definitive preflight rejection. A timeout, lost callback,
or uncertain exception is **not** a preflight rejection and must not be reported
as known failure. Success is never accepted directly from `claimed`.

Identical terminal retries return the original receipt. A different event ID,
opposite outcome or changed result payload raises SQLSTATE `23514`. Preserve
local evidence on conflicts. Wrong-device access raises `42501`; invalid input
uses `22023`; obsolete/current-state mismatches use `55000`. Existing invalid
or disabled token errors retain the baseline's `P0001` behavior.

### `recover_sms_attempts(p_limit integer = 100)`

Service-role-only maintenance primitive; no cron job is installed. The bounded
limit is clamped to 1–1000 devices. Returns the number of selected devices
reconciled. Claim and begin also reconcile their own device on demand.

An expired **unstarted** claim becomes an expired attempt; its queue row becomes
`queued`, with the current attempt and claim ownership cleared. An overdue
`sending` attempt becomes `unknown`. Device heartbeat never extends either
lease. Initial durations: two-minute claim lease, five-minute outcome deadline.

Mutations lock device, then queue, then attempt. Claim/begin/recovery serialize on
the device row and check `clock_timestamp()` after locks, avoiding stale
transaction-start timestamps. If begin wins, recovery cannot requeue; if expiry
wins, the obsolete attempt cannot begin. Cross-device claim selection uses
`FOR UPDATE SKIP LOCKED`.

## Security and advisor findings

New tables have RLS enabled with no device-role policies and no direct `anon` or
`authenticated` table privileges. Device-token RPCs are the intended access path.
Private helper functions have an empty search path and no client execute grants.
The recovery function is service-role-only. Supabase's direct default function
grants are explicitly revoked, including unsafe provisioning/helper exposure
in the baseline.

Expected advisor notices:

- [RLS enabled without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy): intentional default-deny RPC-only tables.
- [Anonymous SECURITY DEFINER RPCs](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) and
  [authenticated SECURITY DEFINER RPCs](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable): intentional application-device-token authentication; possession of an API key alone is insufficient.
- Unused-index information on a new empty database is expected; do not remove
  fencing or foreign-key indexes based on empty-database usage statistics.

## Forward migration and cutover

1. Stop every legacy gateway and prevent restart. Revoking RPCs cannot recall
   messages already held in an old process's memory.
2. Back up and inspect queue state. Apply the forward migrations, never rerun the
   baseline on a deployed database.
3. Existing legacy `claimed` rows become `unknown`, retain their ownership and
   history, and have no fabricated attempt. They are never automatically
   requeued. Associated devices remain blocked until explicitly reconciled.
   Multiple legacy claims for one device are supported by this quarantine.
4. Verify grants, RPC contracts, security/performance advisors, and the tests.
5. Leave Android disabled until the journal/one-submit protocol is implemented
   and physically verified in a later phase.

The migration fixes a baseline pgcrypto schema assumption without moving the
extension: hashing and random-token generation bind to its actual installed
schema. Existing hashes/tokens retain their format and remain usable.

For a **fresh test database**, the unchanged baseline can fail definition-time
validation because it assumes `digest` lives in `public`. The test bootstrap
temporarily disables function-body validation for that baseline transaction,
then the forward migration replaces those functions with schema-qualified ones.
Do not use the baseline functions in the interval. See `supabase/tests/README.md`.

Phase 1 was provisioned separately in the `Enrollment-SMS-SIMPLE` project,
reference `rccdxrmyavihzdrgokpv`, in Enrollment Desk. No sender, ingest secret,
Edge Function deployment, or production contact data was configured as part of
this work. Test fixtures are removed/rolled back after execution.
