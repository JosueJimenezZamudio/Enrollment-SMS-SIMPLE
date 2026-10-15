# Enrollment-SMS-SIMPLE — project handoff

Updated 2026-10-14 after the first controlled CRM SMS and review.

## Current status

Phase 3B remains on reliability-phase-3b, unmerged. One controlled CRM SMS passed:
user confirmed one receipt and Sheet sent status; backend shows one attempt/log;
phone journal retained the exact ACK. Producer is disabled, gateway stopped and
SEND_SMS revoked. User chose to retain LIVE/AUTO/campaign settings with SMS_PAUSED
TRUE. No further sending or merge authorized. See
[controlled test evidence](docs/validation/PHASE3B_FIRST_CRM_SMS_RESULT.md).

Saved compatibility-file readback passed; LeadIntake is unchanged. The live test
used the 69-test bundle. Review adds batched RAW row patches with readback and one
SMS context per campaign preview; 77 local tests pass. These latest performance
changes are not yet installed or verified in live Apps Script. No SMS trigger was
installed. See [review results](docs/validation/PHASE3B_REVIEW.md) and
[installation history](docs/validation/PHASE3B_STOPPED_VALIDATION.md).

Phase 3A is deployed.
It adds client/device bindings, immutable ingest receipts, material-payload conflict
handling and a separate-secret status endpoint. See the authoritative
[Phase 3A contract, cutover and validation record](docs/PHASE3A_PRODUCER_API.md).
Public Phase 3A tables/RPCs and both version-1 Edge Functions are deployed. Separate
ingest/read secrets are configured; `enrollment-sheet-worker` is bound to handset 02
and disabled. Stopped production smoke tests passed, including actual HTTPS auth,
duplicate receipts, message/schedule/routing/ownership conflicts, minimal status
projection and cross-client denial. All synthetic fixtures were removed. The original
Section B queue/attempt/log fingerprints, ten claim receipts and handset heartbeat
timestamps are unchanged. See [deployed evidence](docs/validation/PHASE3A_PRODUCTION_SMOKE.md).
41 handler checks, one HTTP/runtime integration test, 65 SQL checks and three
concurrency scenarios passed before deployment; the 65 rollback-only SQL checks
also passed against the deployed RPCs. No Android/Apps Script/Sheet changes or sends.

Phase 1 is implemented: the dedicated Supabase database has the forward
migrations, explicit send attempts, one-message claims, authorization fencing,
unknown-outcome quarantine, and idempotent terminal RPCs.

Android Phase 2 is implemented on `reliability-phase-2`, based on
`reliability-phase-1` at `b3f500e4ff4c93729309cdac35205a31874044e6`.
It uses the new RPC contract, durable SQLite outcomes, one-submit dispatch,
restart reconciliation and bounded foreground sessions. Keep every legacy
gateway stopped. No Apps Script, Sheet integration, Edge Function, or database
protocol changes have been made in Phase 2. Cutover order is Phase 1 then Phase 2
using merge commits, preserving the reviewed ancestry.

The debug APK builds, local tests pass, and lint has no errors. Section A stopped
validation and Section B's first controlled real SMS passed on handset 02. Exactly
one queue row, attempt and sent log were recorded; the local journal retained the
exact ACK and the owner confirmed one arrival from the expected sender. The phone
was force-stopped and SEND_SMS revoked afterward. No additional sends are authorized.
See [Section A](docs/validation/SECTION_A_RESULT.md),
[Section B evidence](docs/validation/SECTION_B_FIRST_SMS_RESULT.md), and
[implementation details](docs/PHASE2_ANDROID_IMPLEMENTATION.md).

## Dedicated infrastructure

| Item | Value |
| --- | --- |
| GitHub | `JosueJimenezZamudio/Enrollment-SMS-SIMPLE` |
| Supabase project | `Enrollment-SMS-SIMPLE` |
| Organization | `Enrollment Desk` |
| Project reference | `rccdxrmyavihzdrgokpv` |
| Region | `us-west-1` |
| Dashboard | https://supabase.com/dashboard/project/rccdxrmyavihzdrgokpv |
| API base URL | https://rccdxrmyavihzdrgokpv.supabase.co |

This project is independent of Nuntium and the other Supabase projects. Never
reuse their queues, tokens, credentials, tables, or deployments.

Phase 1 and synthetic RPC fixtures were removed after their tests. The live
database retains the original test below plus the controlled CRM test linked above:
queue `5db1073a-021f-4b99-847f-1cba68c56af8`, attempt
`6ac33d07-1fbe-4bd4-b4e0-161446511185`, both sent, one log. Do not reset or replay it.

Handset 02 identity `d800c0ee-12a4-475a-958e-706c69a500cd` remains enabled for
authentication; its Android sending session is stopped and SMS permission denied.
The mistakenly provisioned earlier Enrollment identity
`802bb08b-47ff-4658-a670-353732f75160` is disabled; that handset is reserved for
Nuntium, which was not changed. Credentials and raw handset journals remain private.
Ingest deployment/configuration is now separately validated by stopped Phase 3A smoke tests.

## Product boundaries

```text
Lead automation / Apps Script
  -> queue-enrollment-sms Edge Function
  -> sms_queue + sms_send_attempts
  -> dedicated Android gateway
  -> dedicated SIM
  -> recipient
```

Keep the transport outbound-only, US-only, one GSM-7 segment, and dependency-light.
Preserve server-side septet validation and Android's independent segment check.
Do not add inbound SMS, chatbots, dashboards, multipart sending, or a different
SMS provider without a separate request. Keep the minimum send interval at ten
seconds and polling within the current 5–60-second range.

## Database protocol — authoritative contract

Read [docs/PHASE1_RELIABILITY.md](docs/PHASE1_RELIABILITY.md) before modifying the
protocol. It contains signatures, response shapes, errors, lease rules, role
grants, and cutover instructions. The former batch-claim behavior is obsolete.

Tables:

- `sms_devices`: hashed device-token authentication, enablement, heartbeat.
- `sms_queue`: logical messages, scheduling, business dedupe key, current attempt.
- `sms_send_attempts`: reservation, authorization, deadlines, immutable outcome.
- `sms_claim_requests`: durable receipts for successful, empty, and busy claims.
- `sms_send_log`: terminal outcomes; one log per new-protocol attempt.

```text
queued -> claimed -> sending -> sent / failed
             |          |
             |          +-> unknown -> sent / failed (late callback)
             +-> failed (definitive preflight rejection)
             +-> queued (unstarted claim expires; old attempt becomes expired)
```

`cancelled` remains reserved; Phase 1 adds no cancellation or manual-resolution
RPC. Only unstarted claims can be automatically requeued. `sending` means an SMS
may have been handed to Android. `unknown` must never automatically be resent
and continues occupying the device slot. `sent` means Android send success, not
recipient delivery/read confirmation.

RPCs:

- `device_claim_sms_queue(token, claim_request_id)` returns a JSON object with at
  most one message. Persist the request UUID before calling. Reuse it on network
  retries; use a new UUID only for a new logical poll. No `p_limit` parameter.
- `device_begin_sms_attempt(token, attempt_id)` authorizes an unexpired claim.
  Replays return existing state and never extend its deadline. A restarted
  Android worker must not treat an existing `sending` state as permission to send.
- `device_mark_sms_sent` / `device_mark_sms_failed` require queue ID, attempt ID,
  and outcome-event UUID. Persist the complete immutable payload before reporting.
  Exact repeats return the original receipt; opposite or altered outcomes fail.
- `recover_sms_attempts(limit)` is service-role-only. It expires unstarted claims
  or quarantines overdue authorized attempts; no scheduled recovery job exists.
- `device_heartbeat`, `create_sms_device`, and device-token helpers retain their
  original public signatures. Provisioning and token helpers are not public-client
  operations.

The claim lease is two minutes; the outcome deadline is five minutes. Device,
queue, and attempt row locks serialize transitions. Partial unique indexes enforce
one active attempt per device/message. Heartbeats do not extend leases.

## Migration history and fresh setup

Applied versions, aligned with repository filenames:

1. `001_enrollment_sms.sql` — unchanged historical baseline.
2. `20261011232557_sms_send_attempts.sql` — protocol, legacy quarantine, grants,
   and schema-qualified pgcrypto helper compatibility.
3. `20261011233522_sms_attempt_indexes.sql` — indexes identified by advisor review.
4. `20261013023711_producer_ingest_receipts.sql` — Phase 3A receipts, bindings and producer RPCs.

MCP assigned timestamp versions during application; the three Phase 1 entries
and the later Phase 3A entry were aligned to their matching repository versions. Schema SQL was not changed
by that metadata alignment. Do not replay them on the dedicated project.

The baseline assumes pgcrypto is installed in `public`, whereas Supabase installs
it in `extensions`. For a **new empty test database**, the bootstrap temporarily
sets `check_function_bodies=off` for the baseline transaction; the forward
migration then fixes the affected helpers using pgcrypto's installed schema.
Never invoke the baseline helpers between those steps. Use
[supabase/tests/bootstrap.sql](supabase/tests/bootstrap.sql). Do not rewrite or
rerun the baseline on a deployed database.

Before applying this protocol anywhere with a legacy gateway, stop that process
and prevent restart. It may already hold claimed messages in memory. The migration
converts old `claimed` rows to `unknown`, preserves their history, and blocks their
associated device. Never fabricate send attempts or blindly requeue these rows.

## Verification completed

Run instructions: [supabase/tests/README.md](supabase/tests/README.md).

- 51 sequential database checks passed, including retries, expiry, late outcomes,
  terminal conflicts, wrong-device calls, API-role access, and crypto compatibility.
- Seven two-session concurrency scenarios passed, including duplicate claims,
  competing devices, simultaneous terminal reports, and begin/recovery fencing.
- Seven populated-baseline upgrade checks passed in isolated rollback-only schemas.
- Security and performance advisors were run against the dedicated project.
  Remaining security notices concern intentional token-authenticated SECURITY
  DEFINER RPC access and default-deny RLS tables without client policies.
  Missing foreign-key indexes were fixed; unused-index information on a fresh
  database is not a reason to remove required indexes.
- The preceding database-suite evidence is from Phase 1. On 2026-10-12 the actual
  Android Java RPC client passed a separate live HTTPS contract test using temporary
  non-routable fixtures. It covered heartbeat, claim replay/busy/expiry, begin
  replay, terminal replay, conflict and wrong-device rejection. No service or SMS
  transport was constructed. All fixtures and temporary tokens were removed; all
  five application tables were verified empty afterward. No schema changed.
- Phase 2 Android: debug APK build, 78 Robolectric executions (36 reliability
  cases on API 26 and 35, plus six lifecycle/configuration cases on API 35),
  and Android lint passed. Remaining lint warnings are documented in the
  implementation record. The later physical happy-path evidence is linked above;
  crash/fault scenarios, two-send pacing and Android 15 timeouts remain unverified
  on physical hardware.

The [contract guide](docs/PHASE1_RELIABILITY.md#security-and-advisor-findings)
links the advisor categories and explains the intentional security model.

## Android Phase 2 implementation

The [original design](docs/PHASE2_ANDROID_DESIGN.md) is implemented with a few
conservative choices documented in the [validation record](docs/PHASE2_ANDROID_IMPLEMENTATION.md):
rollback-journal SQLite with FULL synchronization, one active local slot,
and abandonment of a live begin continuation after any uncertain response.

`GatewayJournal` replaces `PendingSendStore`; legacy preferences are preserved
and quarantined. `GatewayCoordinator` is the only dispatch coordinator.
`SmsSentReceiver` commits an immutable callback outcome before scheduling the
upload-only `OutcomeReportWorker`. The reporter validates exact queue, attempt,
event, terminal state and completion timestamp before releasing the slot.
Corruption does not invoke SQLite's default destructive recovery handler.

The app starts stopped after process death. Configuration is bound to a
heartbeat-verified project/device identity; unresolved work blocks switching.
Same-device credential repair can unblock authentication failures, but cannot
clear conflicts, legacy quarantine or unknown outcomes. No general reset/retry
SMS button exists. Reports may continue after sending is paused.

User-started foreground sessions have a one-hour app cap and implement Android
15 `onTimeout`; they never auto-restart. WorkManager reports only and does not
replace the polling session. Ten-second pacing and one GSM-7 segment are enforced.
Do not describe this release as an unattended 24/7 service or exactly-once delivery.

## Next phase

Finish Phase 3B saved-source readback and independent workbook/evidence comparison;
the user-run paused installer and stopped runtime validation have passed.
Keep the producer disabled and gateway stopped. No merge until CRM validation passes.
The user prefers to paste code manually with step-by-step guidance. All SMS behavior
must remain in SmsIntegration.gs; LeadIntake is unchanged, and webhook intake has no
SMS hook. AUTO rollout starts on the explicit test-recipient allowlist under separate
authorization after these checks; preserve independent email controls.

New migration: `20261013023711_producer_ingest_receipts.sql` (deployed).
New tables: `sms_ingest_clients`, `sms_ingest_receipts`, both default-deny RLS.
New service-only RPCs: `producer_enqueue_sms`, `producer_sms_status`.
New endpoint: `sms-queue-status`. Existing ingest header remains unchanged.
New server configuration: `SMS_INGEST_CLIENT_ID` and distinct `LEAD_SMS_STATUS_SECRET`.
Neither endpoint exposes arbitrary rows, contact/message content or device details.

Keep the one-message test evidence. Future fault/transport tests and additional
real sends need their own scope and authorization. Do not present the one
happy-path send as complete physical reliability coverage.

Service-role credentials stay server-side. Android uses an API key plus a device
token; Apps Script uses only scoped ingest/read secrets. Never commit real tokens, secrets,
phone lists, or student/family data. Consent and contact-selection rules remain
upstream; this outbound-only transport does not process STOP replies.
