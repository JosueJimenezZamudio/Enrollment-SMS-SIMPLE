# Phase 2 controlled physical-device validation

Prepared 2026-10-12 on `reliability-phase-2`. **Current authorization stops at
preparation and no-send contract verification. No physical gateway session or
real SMS has been started. Nothing is merged.** Apps Script, Sheets, Edge
Functions and database migrations are unchanged.

## What was verified against the live project

Project `Enrollment-SMS-SIMPLE` (`rccdxrmyavihzdrgokpv`, Enrollment Desk,
`us-west-1`) was `ACTIVE_HEALTHY`. Migration versions were `001`,
`20261011232557`, `20261011233522`. Public RPC signatures and execution grants
matched the [Phase 1 contract](PHASE1_RELIABILITY.md); provisioning and recovery
remain unavailable to anonymous/authenticated API roles.

The actual `SupabaseGatewayClient` and `RpcReceipt` classes ran over HTTPS from
an opt-in Robolectric/JDK harness with the real publishable key and disposable
device credentials. No coordinator, Android service or SMS transport was constructed.
The two queue fixtures had `to_phone = 'NO_SMS_CONTRACT_FIXTURE'`, were routed
only to the temporary owner, and were marked as synthetic database tests.

Passed in the live run:

- Heartbeat identity and app version `2.0.0` for both temporary identities.
- One-message claim, original-request replay and busy response for a new request.
- Expired unstarted claim reconciliation by replaying its original request.
  Only the disposable fixture lease was shortened administratively for this check.
- Begin and repeated begin with unchanged authorization/deadline timestamps.
- Synthetic sent report and identical retry with the same event/completion time.
- Conflicting sent payload rejection (`23514`).
- Wrong-device begin and outcome-report rejection, classified as authorization
  errors. PostgREST returned HTTP 401; the host JDK omitted the SQL error body,
  so the client correctly used its HTTP-status fallback.
- Failure directly from claimed (synthetic preflight rejection), and identical retry.
- Empty request and its immutable replay; invalid token rejection (`P0001`).

SQL inspection then found exactly two synthetic logs, both carrying
`transport_invoked=false`, one sent attempt, one failed attempt and one expired
attempt. Temporary devices were disabled and all test rows deleted by exact
fixture IDs. Final counts were **zero devices, queue rows, attempts, claim
requests and logs**. Temporary device-token files were deleted. No persistent
physical-device token was provisioned by this task.

This verifies the client contract, API gateway/key headers and response parsing
on the host JVM. It does not prove the phone's TLS stack, modem, callback delivery,
OEM power management or carrier submission behavior.

## APK and build

| Item | Verified value |
| --- | --- |
| Application ID | `com.enrollmentdesk.enrollmentsms` |
| Version | `2.0.0`, versionCode `2` |
| Minimum / target SDK | 26 (Android 8) / 35 (Android 15) |
| APK | `enrollment-sms-phase2-debug.apk` (debug signed; not installed) |
| APK SHA-256 | `7153e3db9e1f2d47d95d012d655acc0c99ce382309295fa75bd897523e180329` |
| Signing certificate SHA-256 | `3a66310ca8d44edee3d83d15f08ae864e1451ef6226d73a156c6786fd4b23a6c` |

Runtime Android sources are unchanged from implementation commit
`7c935cdd54f62c83af7a5452596795471b6cbef7`. The preparation change adds an
opt-in live test and documentation; the APK hash is unchanged.

With JDK 17 and Android SDK platform/build-tools 35 installed:

```sh
cd android-sms-gateway
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The normal suite makes no live RPC calls: 78 executions pass, and the one live
contract test skips without a private fixture configuration. Debug build and
lint pass (existing nonblocking warnings remain). The live test passed separately.
Use `app/build/outputs/apk/debug/app-debug.apk` as the build output. Keep the
Gradle wrapper, checksum and dependency lockfile; do not substitute an arbitrary
Gradle/JDK version. Debug signing keys are local and must not be committed.

The merged manifest includes `RECEIVE_BOOT_COMPLETED` and `WAKE_LOCK` from
WorkManager. They allow saved outcome work to resume; they do **not** start the
SMS gateway after reboot. There is no inbound SMS permission/receiver.

## Exact configuration values and device-token provisioning

| App field | Value/source |
| --- | --- |
| HTTPS Supabase URL | `https://rccdxrmyavihzdrgokpv.supabase.co` |
| Publishable / anon API key | Active **publishable** key named `default`, ID `f0332c01-d009-4601-9c91-1d0c7f2650dd` |
| Device token | One-time `device_token` returned by `create_sms_device` below; not the publishable key |
| Poll seconds | `5` (allowed range 5–60) |
| Sending session | Stopped; do not press Start in this stage |

The accompanying `device-configuration.txt` contains the exact current
publishable key for copying. Alternatively, open the
[dedicated project dashboard](https://supabase.com/dashboard/project/rccdxrmyavihzdrgokpv),
Settings → API Keys, and copy the active `default` publishable key (`sb_publishable_…`).
Do not use a secret/service-role key or a disabled key.

For the actual phone, an administrator runs this once in **this project's** SQL
Editor (privileged server-side session, never from the app):

```sql
select * from public.create_sms_device(
  'Enrollment controlled validation - <unique handset label>',
  null
);
```

Replace the label. A phone number is optional and unnecessary for provisioning.
The result contains `device_id` and `device_token`. Save the ID in the validation
record and the raw token in private credential storage; its hash is stored in the
database and the raw value cannot be retrieved later. Do not publish it, put it
in shell arguments/logs/screenshots, or reuse another phone's token.

The database device must be enabled for heartbeat authentication. That does not
start the phone gateway or grant Android SMS permission. Do not call claim/begin
from the phone during stopped configuration. If a provisioned device must be
revoked after a no-send test, an administrator may disable that exact device;
first ensure it has no pending outcomes, because disabled credentials cannot
upload acknowledgments.

To confirm the configured identity/heartbeat without exposing its token:

```sql
select id, name, enabled, last_seen_at, app_version, android_version,
       manufacturer, model
from public.sms_devices
where id = '<the returned device_id>'::uuid;
```

## Installation and stopped configuration (instructions; not yet performed)

1. Use the dedicated handset, USB cable and intended SIM. Record model, Android
   version/security patch, carrier and default-SMS subscription. Enable Developer
   Options → USB debugging and approve only the intended workstation. Run
   `adb devices -l`; choose its serial explicitly for every command. No device
   was attached during this preparation.
2. Stop the existing gateway **before** replacing it. Set these shell variables
   to the observed serial and downloaded APK path:

   ```sh
   DEVICE_SERIAL="<observed device serial>"
   APK="/absolute/path/enrollment-sms-phase2-debug.apk"
   PKG="com.enrollmentdesk.enrollmentsms"
   adb -s "$DEVICE_SERIAL" shell am force-stop "$PKG"
   adb -s "$DEVICE_SERIAL" shell dumpsys activity services "$PKG"
   ```

   Confirm `SmsGatewayService` is absent. Inspect any legacy pending work and
   backend unknown attempts before upgrade. Do not clear app data or uninstall.
   Keep private backups/evidence if that device has ever been used for sending.
3. Verify the downloaded SHA-256 and signing certificate against the table above:

   ```sh
   shasum -a 256 "$APK"
   apksigner verify --print-certs "$APK"
   ```

   `apksigner` is under the Android SDK's `build-tools/35.0.0` directory. If an
   installed build uses a different signing key, `adb install -r` will reject it.
   Stop at that error: recover/use the original signing key or an explicitly
   planned fresh test handset. **Do not uninstall to bypass the mismatch.**
4. Install without clearing data, deny SMS permission, then launch only the UI:

   ```sh
   adb -s "$DEVICE_SERIAL" install -r "$APK"
   adb -s "$DEVICE_SERIAL" shell pm revoke "$PKG" android.permission.SEND_SMS
   adb -s "$DEVICE_SERIAL" shell dumpsys package "$PKG"
   adb -s "$DEVICE_SERIAL" shell am start -n "$PKG/.MainActivity"
   ```

   If revocation says the permission was not granted, confirm its state in the
   package dump or Settings → Apps → Enrollment SMS Gateway → Permissions.
   It must remain denied. Notifications may be allowed independently.
5. Enter URL, publishable key, securely retrieved device token and poll `5`.
   Tap **Test connection (does not save or start)**. Expect heartbeat success
   while Session remains stopped. Check `last_seen_at` for the exact device ID.
6. Tap **Save and verify profile (keeps sending stopped)**. Expect verified
   configuration, no active attempt and no pending reports on a fresh handset.
   If legacy/unknown/conflicting work is shown, stop and investigate; there is
   no safe reset/retry-SMS shortcut. A save must not switch identity when work
   is unresolved.
7. Do **not** press **Start one-hour gateway session**. Recheck the service dump
   and denied SMS permission. Opening the UI, Test Connection and Save do not
   request SMS permission or start sending. Do not enqueue any real recipient.

## Physical-device checklist

Record PASS/FAIL, handset/OS, time, queue/attempt/event IDs where applicable, and
identifier-only evidence. Every physical check below is **NOT RUN** at preparation.
Never mark the host contract test as a phone/carrier test.

### A. Stopped checks — no sending permission, no active session

- [ ] **Installation/upgrade:** versionCode 2 and expected certificate; data preserved;
  old service absent; legacy `enabled=true` is not resumed. Legacy pending entries
  remain quarantined rather than converted into new attempts.
- [ ] **Heartbeat/identity:** Test Connection succeeds for the expected device;
  SQL `last_seen_at` changes; app version is 2.0.0. Invalid credentials fail without
  starting a session or overwriting the saved profile.
- [ ] **Permissions:** SEND_SMS denied; notification preference recorded separately;
  no inbound SMS permission. Do not grant SMS permission in this stage.
- [ ] **SIM selection:** in system Settings, choose one explicit default SMS SIM
  (not “ask every time”); record intended subscription/carrier. Inspect only—do
  not send a system test SMS. Do not assume an arbitrary SIM will be selected.
- [ ] **Network loss:** with session stopped, disable Wi-Fi/mobile data and use
  Test Connection; expect a visible failure and unchanged saved configuration.
  Reconnect and retest; no queue/attempt/log records should be created.
- [ ] **Screen off:** lock/unlock during stopped configuration; no gateway service
  starts and no claim occurs. This does not establish active screen-off sending.
- [ ] **Reboot/force-stop:** force-stop and reopen, then reboot/reopen; session
  remains stopped, verified profile persists, and SEND_SMS remains denied.
  WorkManager may resume uploads only if saved outcomes already existed.
- [ ] **Journal baseline:** fresh journal readable, no active slot or outcomes;
  reopening preserves the profile and does not create an attempt. Do not reset
  an existing journal to manufacture a clean result.

### B. Active-session/fault checks — deferred until separately authorized

The current APK has **no dry-run sending mode**. Starting a session with SMS
permission can submit any eligible queue item. An empty queue alone is not a
sending interlock. Do not execute this section under the current no-send stage.
Use a separately authorized controlled recipient/test environment, or a separately
reviewed fake-transport instrumentation build, before active tests.

- [ ] **Permission denial/revocation:** denial prevents start; revocation before
  preflight records a known failure without begin. Revocation after authorization
  leaves uncertainty unless a genuine callback resolves it; no automatic resend.
- [ ] **SIM ambiguity/change:** no default fails closed; a subscription change
  between preflight and submission does not silently select another SIM. An
  uncertain platform exception is not turned into a fabricated failed callback.
- [ ] **One segment/pacing:** GSM-7 extensions count twice, >160 septets/non-GSM-7
  rejected. If two controlled sends are authorized, invocation boundaries remain
  at least ten seconds apart, including after session/process restart.
- [ ] **Screen off/background:** during a bounded session, heartbeat/polling and
  callback persistence continue as supported by that handset. Record OEM battery
  behavior; do not treat a foreground notification as proof of successful transport.
- [ ] **App session timeout:** the one-hour cap stops the service and invalidates
  any delayed begin continuation; a pending outcome remains stored/retryable.
- [ ] **Android 15 platform timeout:** test `onTimeout` with a shortened platform
  budget as described below; service stops promptly and does not auto-restart.
- [ ] **Reboot at PREPARED:** original claim request replays; only an unstarted,
  still-valid claim may resume after a new explicitly started session.
- [ ] **Reboot/process death after DISPATCH_COMMITTED:** no SMS replay, including
  the gap before begin. Replay original claim until expired/sending/unknown is
  known; only backend-confirmed unstarted expiry releases the slot.
- [ ] **Network loss around claim/begin:** same claim UUID on retry; lost begin
  response leads to reconciliation, never a second submission continuation.
- [ ] **Callback saved while offline:** local outcome/event/payload survives process
  death and network loss. Reconnect: upload the same payload; no new claim while
  it is pending. Sending can remain stopped throughout reporting.
- [ ] **Lost ACK/ACK commit failure:** repeat identical terminal RPC until the exact
  acknowledgment commits locally; one backend log, same event and completion time.
- [ ] **Missing/late/duplicate callback:** sending becomes unknown and blocks new
  work; a genuine late callback can resolve it. Duplicate callback retains its
  first event. Contradiction pauses processing and preserves evidence.
- [ ] **Journal/storage failure:** dispatch guard failure means no begin/SMS call;
  callback/ACK write failures retain uncertainty/pending evidence. Missing/corrupt
  database fails closed, not silently recreated into a sendable state. Do not
  induce corruption on the operational handset; use an isolated test copy/build.

### Android 15 timeout procedure (deferred active test)

On the isolated Android 15 test handset, record the original setting first:

```sh
adb -s "$DEVICE_SERIAL" shell device_config get activity_manager data_sync_fgs_timeout_duration
adb -s "$DEVICE_SERIAL" shell device_config put activity_manager data_sync_fgs_timeout_duration 60000
```

Only in the separately authorized active test, start a session from the visible
app, then background it. Expect timeout/stop and preserved journal state. A
pending HTTP response cannot dispatch after the timeout. Check service state and
identifier-only journal evidence. Android 15 dataSync has an aggregate six-hour
background budget per 24 hours; the app's one-hour cap is additional, not an
exemption. API 35 is already targeted, so no compatibility override is required.

Afterward restore the exact original value. If the original result was `null`:

```sh
adb -s "$DEVICE_SERIAL" shell device_config delete activity_manager data_sync_fgs_timeout_duration
```

Otherwise use `device_config put ... <recorded-original-value>`. These settings
can affect other test apps; do not leave the shortened budget installed.

## Journal evidence and recovery rules

The private database is `databases/gateway-journal.db`. On a debug-signed test
handset, `run-as com.enrollmentdesk.enrollmentsms` can read app-owned files.
For a snapshot, stop sending and force-stop the app first; copy the database
**and any associated `-journal` file** into a mode-700 private workstation
folder (`umask 077`). Never copy snapshots back over the phone's live database.
Message content may still be present, so do not attach the database to a public PR.

On the copied files only, use SQLite to inspect `requests.active`,
`attempts.phase`, and `outcomes.event/kind/acked/blocked`, plus `health` and
identifier-only `events`. Record counts/IDs, not phone/body/payload/token data.
A host SQLite `PRAGMA synchronous` reports that host connection's setting,
not the handset connection; the app checks FULL synchronization on every open.

Preserve these outcomes:

| Local state | Safe recovery |
| --- | --- |
| Pending claim request | Replay original UUID; never guess it or replace it after a timeout |
| PREPARED | Reconcile; only the still-unstarted path may later dispatch |
| DISPATCH_COMMITTED / UNCERTAIN | Never replay SMS; reconcile original request; unknown requires investigation |
| OUTCOME_PENDING | Retain exact event and payload until matching ACK; do not clear app data |
| ACKNOWLEDGED | No resend; minimal callback evidence remains |
| Legacy pending / unexplained busy / conflict / corrupt journal | Stop; operator investigation, no automatic reset or requeue |

## Opt-in host live test

`LiveRpcContractTest` is excluded by assumption unless `-PliveRpcConfig` names a
private JSON fixture file. It requires disposable device identities, two due
queue rows routed to the owner, the non-routable fixture marker above, and an
otherwise empty dedicated project. **Never point it at the physical-device token
or real queue rows.** The fixture schema has `url`, `publishable_key`, `run_id`,
`disposable_no_sms_fixture: true`, `owner_id`, `owner_token`, `other_id`,
`other_token`, `sent_queue_id`, `failed_queue_id`, and optional expired request/
attempt IDs. A privileged operator prepares/cleans those exact fixtures; the test
itself has only device-token RPC access. Keep the file outside the repo, mode 600.

```sh
./gradlew :app:testDebugUnitTest --tests '*LiveRpcContractTest' \
  -PliveRpcConfig=/private/path/to/disposable-fixture.json
```

Cleanup must revoke/delete the two fixture devices and remove their exact logs,
claim receipts, queue-current-attempt references, attempts and queue rows; confirm
no fixture rows remain, then delete the private token file. A synthetic `sent`
row from this harness is not evidence of SMS submission.

References: [Android ADB](https://developer.android.com/tools/adb),
[foreground-service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout),
[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).
Supabase also announced removal of older TLS CBC cipher suites starting no earlier
than 2026-11-10; test heartbeat on the actual handset's supported/updated OS rather
than inferring device TLS compatibility from the successful host test.
[Supabase TLS change](https://supabase.com/changelog/cbc-tls-ciphers-deprecated)
