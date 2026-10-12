# Phase 2 Android implementation and validation

Implemented on `reliability-phase-2`, based on Phase 1 commit
`b3f500e4ff4c93729309cdac35205a31874044e6`. No merges, database changes,
Apps Script/Sheets changes, gateway starts, device installation or real SMS sends.

## Implemented protocol

- Durable `SQLiteOpenHelper` journal: profiles, original claim requests, attempts,
  immutable outcomes, acknowledgment receipts, diagnostic events and guard time.
  A unique active-request index and conditional dispatch update fence concurrent workers.
  Transactions use FULL synchronization and a single connection/rollback journal.
  Corruption throws instead of deleting/recreating the database. Backup and device
  transfer exclude credentials and journal data.
- Claim UUID committed before RPC. Claim responses are objects, validated for
  identity, state, timestamps and payload. No legacy `p_limit` or array fallback.
  Restart uses only the original claim UUID for reconciliation. `begin` is called
  only by the live continuation that won a fresh durable dispatch transition.
- The guard is committed before begin. A process/session generation, a 60-second
  monotonic window and serialized pause/submission boundary permit at most one
  `sendTextMessage` invocation per attempt. Any uncertainty after the guard forbids
  automatic submission replay. Server-confirmed unstarted expiry alone releases
  an abandoned claim; sending/unknown remain blocked until a real result arrives.
- Callback identity uses an explicit, unexported receiver and a unique profile/
  attempt URI. `goAsync` covers the local commit and work scheduling, with no
  network in the receiver. The first outcome's UUID, metadata, result and payload
  are immutable. Duplicates retain that payload; contradictions preserve evidence
  and stop automatic processing. ACKs must match queue, attempt, event, state and
  a valid completion timestamp. A generic HTTP 2xx cannot release the slot.
- WorkManager uploads saved outcomes with connectivity constraints, unique event
  work, exponential retry and persisted numeric Retry-After deferral. Startup and
  session scans recover commits that preceded scheduling. Reporting can continue
  when sending is stopped; force-stop can delay it until the app is reopened.
  A `55000` report rejection can replay its original claim receipt solely to
  establish safe unstarted expiry. It never claims a fresh request or begins an attempt.
- US number, GSM-7 septet counting and Android `divideMessage` checks require one
  segment. A valid explicit default SMS subscription is bound before begin and
  checked again before invocation. No ambiguous default, alternate SIM fallback,
  multipart send, inbound permission or inbound receiver is added.
- At least ten seconds between invocation boundaries, using monotonic time.
  Every new process/session waits a full ten seconds. Device wall time never
  determines lease validity or permits dispatch.
- Test Connection only heartbeats. Save verifies identity and keeps sending
  stopped; Start is a separate explicit action. Unresolved work blocks project/
  device switching. Same-device credential repair only clears authentication
  blocks, not outcome conflicts or legacy quarantine.
- `START_NOT_STICKY`, no boot-triggered sending, a one-hour session cap, and Android
  15 `onTimeout` invalidation/stop. Reporting workers do not run SMS transport.
  WorkManager's own system rescheduling receivers can restart uploads only.

This is at-most-once **application submission per attempt**, not exactly-once
carrier delivery. A crash between the guard and SMS invocation may leave an
unsent message unknown; avoiding duplicates takes priority over automatic retry.

## Conservative implementation choices

The original design allowed WAL with FULL synchronization; this implementation
uses rollback journaling with FULL synchronization to keep one connection and
straightforward durability. A single active slot spans the current installation
rather than supporting simultaneous profiles. Raw credentials remain in private,
backup-excluded preferences; journal rows store profile/device bindings.

A transient begin failure immediately abandons its live continuation instead of
retrying begin within the same process. Replaying the saved claim eventually
establishes expiry or unknown state. This is deliberately more conservative and
can leave an authorized-but-unsent message unknown.

The original plan suggested a persistent worker-generation field. The durable
phase is the cross-process fence; the generation is intentionally memory-only so
a restart cannot reconstruct authorization to submit. The guard timestamp is
persisted for audit, not used as a post-restart permission to send.

## Reproducible local checks

Prerequisites: JDK 17, Android platform 35/build-tools 35, and dependency downloads.
Gradle 8.9 wrapper/distribution checksum, AGP 8.7.3, WorkManager 2.10.5 and
Robolectric 4.14.1 are pinned. Gradle dependency locks record resolved versions.
WorkManager 2.10.5 includes fixes for network-constrained work while staying on
the compile-SDK-35-compatible release line.

```sh
cd android-sms-gateway
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

When a sandbox prevents home-directory writes, set `GRADLE_USER_HOME` and
`ANDROID_USER_HOME` to writable scratch directories. Robolectric's download
cache/lock lives under the app's build directory. Gradle requires local sockets;
network permission was needed in this session. No production credentials are
needed by the tests.

Validation completed:

- Debug APK assembled successfully.
- 78 passing Robolectric executions: 36 reliability cases on each of API 26 and
  API 35, plus six API-35 lifecycle/configuration cases. Tests use fake RPC/SMS
  transport, temporary SQLite files and injected transaction failures.
- Coverage includes lost claim/begin responses, process death after the guard,
  death after submission, duplicate coordinators/guards/callbacks, conflicting
  outcomes, late callbacks, malformed/wrong ACKs, failed callback and ACK commits,
  paused reporting, preflight rejection/expiry, unknown quarantine, ten-second
  pacing, changed SIM, expired live dispatch window, profile switching, legacy
  pending evidence, service timeout and startup disabled state.
- Android lint: zero errors. Remaining warnings concern newer dependency versions,
  the pre-existing missing app icon, intentionally required telephony hardware,
  and English UI strings/localization. They do not establish physical SMS behavior.
- Gradle wrapper JAR SHA-256 matched the official Gradle 8.9 checksum.
- `git diff --check` passed. ADB listed no attached devices.

## Before any real send (not executed)

Keep the legacy gateway stopped. Do not install/start this APK against a live
queue during local testing. A separate controlled-device authorization is needed
for SIM/permission behavior, actual callback success/failure, radio exceptions,
network loss during reporting, process death/reboot, screen-off operation and
Android's actual foreground-service budget enforcement. Robolectric lifecycle
checks do not simulate a modem or all OEM power-management behavior.

Inspect legacy pending preferences and backend unknown rows before upgrade. They
remain quarantined; no reset, automatic requeue or fabricated terminal outcome is
provided. Unknown attempts, contradictory outcomes, corrupted/missing journals
and unexplained busy claims require operator investigation. Do not clear app
data or uninstall as a recovery method. Same-device credential repair is the
only automatic attention-clear path.

The dedicated Supabase schema remains the Phase 1 protocol. This phase did not
exercise a configured phone against live Supabase or run a complete carrier flow.
No runtime migration/cutover or upstream integration was performed.

References: [Phase 1 RPC contract](PHASE1_RELIABILITY.md),
[Android foreground-service limits](https://developer.android.com/develop/background-work/services/fgs/timeout),
[WorkManager release notes](https://developer.android.com/jetpack/androidx/releases/work#2.10.5).
