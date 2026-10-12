# Enrollment-SMS-SIMPLE — project handoff

Updated 2026-10-11 after Phase 1 database implementation and verification.

## Current status

Phase 1 is implemented: the dedicated Supabase database has the forward
migrations, explicit send attempts, one-message claims, authorization fencing,
unknown-outcome quarantine, and idempotent terminal RPCs.

**The Android source is still the original client and is incompatible with the
new mutation signatures. Keep every legacy gateway stopped.** Android Phase 2
must implement the durable journal and one-submit protocol before any physical
send. No Apps Script or Sheet integration changes have been made.

The system is not yet verified end to end. Successful database tests do not mean
an APK was built, a phone was configured, or an SMS was sent.

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

At the completion of Phase 1 verification, all five application tables were
empty: temporary test data and upgrade-test schemas had been removed or rolled
back. No production device token, ingest secret, Edge Function deployment, or
physical sender was configured during Phase 1. Verify actual live state before
future deployment; do not assume it remains unchanged.

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

MCP assigned timestamp versions during application; those three history entries
were then aligned to the matching repository versions. Schema SQL was not changed
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
- Android source, Apps Script, and Edge Function source were not changed. The
  earlier Android build attempt was blocked by a missing local Android SDK.
  No physical-device SMS behavior has been verified.

The [contract guide](docs/PHASE1_RELIABILITY.md#security-and-advisor-findings)
links the advisor categories and explains the intentional security model.

## Android Phase 2 requirements

The implementation-ready [Android Phase 2 design](docs/PHASE2_ANDROID_DESIGN.md)
is documentation only; Android code has not been changed.

Design and implement a transactional local journal, typed new-contract RPC client,
one active worker, durable dispatch guard, callback persistence before reporting,
immutable retry payloads, acknowledgment validation, and restart reconciliation.
Unknown outcomes must pause sending and remain visible. Configuration changes
must not redirect outstanding reports to a different project/device.

Address Android 15 foreground-service timeouts explicitly; `START_STICKY` does
not make a `dataSync` service an unlimited background process. Physical-device
validation is required for permissions, SIM selection, pacing, callbacks, reboot,
process death, and network failures. Preserve outbound-only permissions.

## Remaining setup after Android is ready

1. Verify the database state and deploy/test the Phase 2 APK.
2. Provision a dedicated device token securely and test heartbeat.
3. Deploy the Edge Function with its custom ingest authentication and configure
   `LEAD_SMS_INGEST_SECRET`. Do not remove custom authentication when disabling JWT
   verification for this service endpoint.
4. Use one controlled recipient to verify the complete queue/attempt/callback/log
   flow and duplicate-ingest protection.
5. Only after transport verification, plan upstream Apps Script/Sheet integration.
   That integration is explicitly outside the current work.

Service-role credentials stay server-side. Android uses an API key plus a device
token; Apps Script uses only the ingest secret. Never commit real tokens, secrets,
phone lists, or student/family data. Consent and contact-selection rules remain
upstream; this outbound-only transport does not process STOP replies.
