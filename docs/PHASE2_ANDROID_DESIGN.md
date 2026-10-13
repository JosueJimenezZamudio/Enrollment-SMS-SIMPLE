# Phase 2 design: Android against the Phase 1 RPC contract

Status: original design from 2026-10-11, now implemented on `reliability-phase-2`.
See [implementation and validation](PHASE2_ANDROID_IMPLEMENTATION.md) for actual scope and remaining checks.
Phase 1 was published first in PR #1. This document is a separate planning commit.
Apps Script, Sheets, Edge Function behavior, and database migrations remain outside
Phase 2 implementation scope unless a separately reviewed contract change is needed.

## Decision and safety boundary

Implement one application submission per attempt with a transactional local journal.
An SMS with an uncertain submission/outcome is never automatically resubmitted.
A queue message may receive another automatic attempt only when Supabase proves
its former claim expired before send authorization. This is not exactly-once
carrier delivery. A crash can leave an authorized message unsent but unknown;
that is the deliberate tradeoff for avoiding duplicate application submissions.

Use the existing [Phase 1 contract](PHASE1_RELIABILITY.md). Add no backend API in
this phase. Do not put the service-role key on Android or call administrative
`recover_sms_attempts` from the device.

## Components and file changes proposed

| Component | Responsibility |
| --- | --- |
| New `GatewayJournal` / `SQLiteOpenHelper` | Transactional requests, attempts, frozen outcomes, acknowledgments and pacing. Replaces destructive SharedPreferences pending-send storage. |
| New `GatewayCoordinator` | Single-process, serialized state machine; only component permitted to invoke the SMS transport. |
| `SupabaseGatewayClient` | Typed claim/attempt receipts; required UUIDs; strict ACK validation; structured HTTP/SQL errors. Remove array-based claiming and per-retry outcome mutation. |
| `SmsGatewayService` | Foreground lifecycle, bounded polling, heartbeat and coordinator scheduling. No batching or independent send loops. |
| `SmsSentReceiver` | Capture callback, durably record its immutable result, schedule reporting; never send or wait on network. |
| New `OutcomeReportWorker` | WorkManager worker uploads a saved outcome only. It has no claim, begin, or SmsManager capability. |
| `GatewayConfig` / `MainActivity` | Bind journal entries to project/device profile; show actual worker health, pending ACKs and attention states; separate connection test from starting the gateway. |
| `PendingSendStore` / `OutboxMessage` | Retire destructive `pop`; replace message-only data model with attempt-bound records. Quarantine legacy pending entries. |
| Build/tests | Reproducible Gradle wrapper, pinned WorkManager dependency, unit/instrumentation tests and device fault-injection checklist. Keep Java/package ID and outbound-only permissions. |

SQLite is available on Android; Room is unnecessary for this small journal.
WorkManager is the one proposed runtime dependency, used for outcome reporting
only. Select and pin a supported version when implementing; do not use periodic
work to emulate the 5-second claim loop.

## Local data model

Use a private transactional database with foreign keys enabled and durable commit
settings; verify synchronous writes on every connection (for example WAL with
FULL synchronization) on the test device. Disk-full, corruption, or failed commits
halt dispatch. Do not use asynchronous SharedPreferences writes for safety state.

- `profiles`: local profile UUID, canonical HTTPS project URL, device UUID obtained
  from heartbeat, configuration generation and reference to credentials. Keep raw
  tokens out of journal diagnostics and callback intents.
- `claim_requests`: profile, persisted request UUID, phase (`pending`, `received`,
  `retired`), result, linked attempt and last safe transport error. Permit only one
  pending logical request per active profile.
- `attempts`: profile, original claim-request UUID, queue/attempt UUIDs, payload
  while needed, server receipt/deadlines, local phase, worker generation,
  dispatch marker, SIM binding, callback URI and timestamps. Unique attempt ID;
  only one local active slot per profile.
- `outcomes`: one accepted outcome per attempt; stable event UUID; terminal kind;
  exact serialized RPC payload; acknowledgment; retry scheduling. Outcome data
  becomes immutable once committed. Never rebuild it with a fresh `reported_at`.
- `events`: bounded, identifier-only diagnostics and conflicting-callback evidence.
- `pacing`: latest submission guard timestamp/boot identity and monotonic timing.

Message phone/body can be removed after matching server ACK or confirmed unstarted
expiry. Retain minimal attempt/event tombstones for duplicate callbacks. Exclude
credentials and journal from backup/device-transfer paths; do not clone profiles
onto another phone. Do not promise secure erasure of SQLite pages without separate
storage measures. Clearing app data/uninstalling is an operational incident,
not a retry mechanism.

## Local state machine

```text
CLAIM_PENDING -> PREPARED -> DISPATCH_COMMITTED -> OUTCOME_PENDING -> ACKNOWLEDGED
                    |                 |
                    |                 +-> UNCERTAIN -> OUTCOME_PENDING (late callback)
                    +-> OUTCOME_PENDING (known preflight rejection)
                    +-> RETIRED_UNSTARTED (server confirms expiry)
```

`DISPATCH_COMMITTED` is a durable point of no replay, written **before** the begin
RPC. It does not assert that the SMS API was called. `UNCERTAIN` closes the original
worker's right to submit and blocks new work. Authentication, contract, storage,
and contradictory-result problems additionally set an attention flag; they do
not erase or rewind an attempt's phase.

All Android components stay in one application process. The coordinator has one
executor; a conditional SQLite transition from `PREPARED` is the final arbiter
against duplicate dispatch. Use a short-lived in-memory worker-generation token
for the winning continuation. A service stop, timeout, restart, or explicit pause
invalidates it. A delayed HTTP response cannot recreate that token. Never hold
an SQLite transaction open across network or SmsManager calls.

## Exact successful sequence

1. Before new work, scan the journal, schedule unacknowledged reports, reconcile
   the previous request, and enforce the ten-second pacing guard. A known pending
   ACK or uncertainty blocks new claims.
2. Save a fresh claim-request UUID, then call `device_claim_sms_queue` with
   `p_device_token` and `p_claim_request_id`. Repeat that UUID after any uncertain
   HTTP result. Persist and validate the JSON-object response before proceeding.
3. For `claimed`, bind queue ID, attempt ID, original request ID and profile, and
   commit `PREPARED`. Validate that message.id equals queue_id, UUIDs match, content
   exists, state is recognized, and receipt timestamps parse. Any schema mismatch
   pauses; it is not an empty queue.
4. Check enabled state, runtime SEND_SMS permission, selected/default SMS SIM,
   available SmsManager on the supported API level, GSM-7/one-segment validation,
   configuration binding and pacing. Initially support a dedicated single SIM or
   unambiguously configured default; fail closed on an ambiguous sender. Do not
   silently use another SIM. Physical-device verification is mandatory.
5. Create an explicit callback PendingIntent keyed by a unique URI containing the
   profile and attempt UUIDs. Integer request-code uniqueness is not sufficient;
   intent extras do not define PendingIntent identity. Keep the receiver unexported.
6. Atomically change `PREPARED` to `DISPATCH_COMMITTED`; save callback identity and
   dispatch ownership. Start a conservative 60-second monotonic dispatch window
   for this live continuation; expiry invalidates it and triggers reconciliation,
   never an SMS retry. A failed commit means no begin RPC and no SMS call.
7. The originating live worker invokes `device_begin_sms_attempt`. It may retry
   the same attempt while its generation is active and it knows it has not invoked
   SmsManager. Only a valid `sending` receipt for this queue/attempt permits its
   one continuation. `expired`, `unknown` and terminal responses never permit send.
8. Recheck generation, dispatch-window expiry, enabled state and local phase immediately before the
   submission boundary. Serialize that boundary with pause/stop processing, set
   its in-memory consumed flag, and call `sendTextMessage` once. Once this call is
   entered, every exception/timeout is treated conservatively as uncertainty unless
   an actual callback provides the outcome. There is no automatic send retry.
9. Persist the callback outcome and frozen terminal RPC payload locally, then
   report it. Validate the returned queue ID, attempt ID, state, outcome-event UUID
   and completion timestamp. A generic HTTP 2xx or empty object is not an ACK.
10. Commit `ACKNOWLEDGED` locally before freeing the active slot and pruning payload.
    If the app dies before that commit, repeat the same terminal report safely.

Pausing cannot recall an SMS already submitted. If a pause races the final
submission boundary, the serialized winner determines whether that one call
occurs. After pause completes no queued continuation may submit another message.

## Reconciliation using the existing RPCs

**Do not use begin as a generic status probe.** Calling it on an unstarted claim
can authorize sending. The safe device reconciliation path is to replay the
persisted original `claim_request_id`. For a known successful request, Phase 1
returns that attempt's current state and performs safe expiry reconciliation;
it never acquires a replacement for that request.

| Local situation | Server receipt / action | Result |
| --- | --- | --- |
| Claim HTTP response lost | Replay persisted request UUID | Recover the same claim, or the same empty/busy result. |
| `PREPARED`, never crossed dispatch guard | Original request returns `claimed` | May resume preflight under the single coordinator. |
| `PREPARED` | Returns `expired` | Retire unstarted attempt; a later fresh poll can create a different attempt. |
| `DISPATCH_COMMITTED` after process death | Replay original request; never invoke begin from startup | No resumed SMS submission. |
| Abandoned dispatch, server still `claimed` | Continue replay until server expires it; do not mark sending or invent failure | Safe expiry eventually releases the slot. |
| Abandoned dispatch, server `sending` | Keep uncertain; replay original request periodically | Deadline reconciliation eventually returns `unknown`; never resubmit. |
| `unknown` | Wait for real late callback or operator investigation | Block claims; no "retry SMS" button. |
| `OUTCOME_PENDING` | Upload the exact frozen terminal payload | Lost responses are safe to retry until matching ACK. |
| Preflight failure report rejected after lease expiry | Replay original request; require `expired` before retirement | Do not alter the failed payload or turn it into a send. Preserve rejection evidence. |
| Server terminal result, no local outcome | Validate identity, retain as remotely completed with an audit note | Do not fabricate a callback or invoke the terminal RPC with a new event. |
| `busy`, attempt unknown locally | Halt with attention; null ID indicates legacy quarantine | No payload or original request identity exists; do not guess or begin that attempt. |
| Journal missing/corrupt or device identity changed | Fail closed; operator reconciles backend before re-enabling | Never clear server state automatically. |

An empty or busy claim receipt is immutable. Replaying it cannot tell the client
that a device became free. Retire ordinary empty polls and allocate a new request
UUID at the configured interval. An unexplained busy result pauses for recovery;
do not issue new IDs in a loop. On reinstall, a busy receipt cannot recover the
missing original request ID; the Phase 1 API has no read-only lookup-by-attempt RPC.
That limitation requires operator handling, not misuse of begin.

Server expiry uses server time. Device wall-clock estimates are hints only; they
cannot authorize dispatch or declare a safe expiry. Polling/reconciliation stays
within 5–60 seconds, with bounded exponential backoff for transport failures.

## Callback persistence and reporting

Capture the callback result code before leaving `onReceive`. Use `goAsync()` for
only the short local transaction and scheduling work, and finish its pending
result in a `finally` block. No network waits inside the receiver. Android limits
receiver execution; a bare detached thread does not establish durable completion.
[Android broadcast guidance](https://developer.android.com/develop/background-work/background-tasks/broadcasts)

The first committed callback creates one outcome UUID and immutable payload.
Freeze callback time, Android result, app version and SDK metadata at that point.
Use a stable synthetic message identifier such as `android:<attempt_id>` when
Android supplies no carrier message ID; do not generate a new one on each upload.
An identical later callback does not generate a second event or timestamp. A
contradictory callback retains separate diagnostic evidence and pauses the gateway;
it never replaces the accepted payload or sends the opposite terminal report.
Unknown/late callback IDs without a journal binding are quarantined, not guessed.

Schedule one unique one-time WorkManager upload per persisted outcome-event UUID,
requiring network connectivity. Retry transient errors with platform backoff.
On app/service startup, scan for records that committed before their work request
was scheduled. Work scheduling supplements the journal; it is not the source of
truth. The reporter can run after new sending is paused, but never submits SMS.
Force-stop may delay work until the user reopens the app; retain evidence throughout.
[WorkManager work and retry guidance](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)

Error policy:

- Network timeouts, 429 and transient server errors: retry the same logical request
  or outcome, honoring server retry hints. These never trigger SMS retransmission.
- Invalid/disabled token (`P0001`), 401/403 or wrong owner (`42501`): retain records,
  stop new sends, surface configuration/authorization attention.
- Payload/contract errors (`22023`, missing RPC, unexpected shape): stop and surface
  compatibility error. Never fall back to the legacy API.
- Terminal conflict (`23514`): retain both local evidence and server conflict;
  stop automatic reporting for that event and request operator review.
- State mismatch (`55000`): reconcile via original request ID. Retire only when
  safe unstarted expiry is established; otherwise retain and pause.

## Pacing, configuration and lifecycle

Use monotonic time within a live process. Persist the guard; after restart/reboot
wait at least a full ten seconds before any new eligible dispatch rather than
trusting a changed wall clock. Pacing is evaluated again at the actual submission
boundary. A lease that expires while waiting cannot be bypassed.

Bind all pending data to the original profile, device UUID and configuration
version. Block switching project/device with unresolved work. Credentials for
the same identity may be repaired only after heartbeat verifies that identity;
never redirect an old report through a newly saved profile. Test Connection must
not call the existing save-and-start path. Keep backup disabled.

UI states should reflect journal/coordinator reality: stopped, ready, claiming,
waiting for callback, reporting outcome, disconnected with saved work, unknown
outcome, or attention required. Display identifiers and safe errors, not message
bodies/tokens. An enabled switch alone must not label the gateway healthy.

For the initial Phase 2 release, support **user-started bounded gateway sessions**.
Keep a foreground service during active polling, implement `onTimeout(int,int)`
on supported versions, invalidate dispatch continuations, preserve journal state
and promptly stop. Outcome-report work remains separately scheduled. Do not use
boot receivers or background restart loops to evade timeouts, and do not silently
relabel the service type. Android 15+ limits background `dataSync` service time to
six hours per 24 hours for apps targeting API 35+. This release must not promise
unattended 24/7 polling; that operational requirement needs a separate supported
lifecycle design and device validation.
[Android foreground-service timeout rules](https://developer.android.com/develop/background-work/services/fgs/timeout)

## Upgrade and rollout

1. Stop the old gateway and inspect any `pending_sends` SharedPreferences entries
   before upgrading. Retain them as legacy evidence; they lack attempt/event IDs
   and cannot be promoted into new sends or guessed terminal reports.
2. On first new-client launch, default sending to disabled, create the journal,
   and require profile/heartbeat verification. Detect old configured state rather
   than silently adopting its `enabled=true` setting.
3. Inspect backend legacy unknowns; no automatic requeue or journal-reset escape.
4. Run local fault-injection tests and new-contract integration tests in isolation.
5. Install on the dedicated SIM device and verify one controlled recipient with
   network interruptions, service stop, process death, reboot and delayed callback.
6. Enable operational use only after those checks; Apps Script/Sheets are a later
   separately authorized phase. No live lead list is needed to verify Phase 2.

## Implementation slices and acceptance

1. **Journal and RPC types:** SQLite transactions, typed contract parsing, profile
   binding, exact outcome serialization and required UUID handling.
2. **Coordinator:** one claim, preflight, durable guard, begin, single transport
   invocation, pacing, generation cancellation and startup reconciliation.
3. **Callback/reporting:** immutable outcomes, idempotent worker uploads, strict ACK
   matching, late/duplicate/conflicting callbacks and safe diagnostics.
4. **Lifecycle/UI:** bounded foreground sessions, timeout handling, pause versus
   report distinction, credential repair and legacy-upgrade quarantine.
5. **Build and physical verification:** pinned reproducible tooling, instrumentation
   and controlled-device evidence before declaring SMS transport complete.

Use a fake SmsTransport with an invocation counter for deterministic tests; never
use real SMS for fault-injection loops. Inject death before/after every durable
write, begin request/response, SMS invocation, callback commit and ACK commit.
Assert at most one invocation per attempt, no invocation from recovered committed
state, no new claim while outcome/unknown is unresolved, and byte-stable outcome
payloads across retries. Exercise duplicate workers/callbacks, delayed HTTP replies
after pause, disk-full, clock changes, permission denial, changed SIM, profile edits,
malformed 2xx ACKs, unknown SQL errors and old pending records.

A real phone must establish successful and failed callback behavior, lost-ACK
recovery, screen-off operation, process death/reboot, and timeout handling under
its Android version. Database tests and emulators alone cannot establish carrier
submission behavior. This document originally specified the design; implementation/build evidence is
recorded separately. Physical-device verification remains pending.
