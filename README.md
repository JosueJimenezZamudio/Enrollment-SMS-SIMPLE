# Enrollment SMS Starter

> **Reliability validation:** Phase 1 database fencing and the Phase 2 Android
> journal passed database/local tests, stopped physical-device checks, and one
> controlled real SMS with exact local ACK and recipient confirmation.
> See [Section A](docs/validation/SECTION_A_RESULT.md),
> [Section B](docs/validation/SECTION_B_FIRST_SMS_RESULT.md), and the
> [RPC contract](docs/PHASE1_RELIABILITY.md). The phone was stopped and SMS
> permission revoked after testing. Further sends require separate authorization.
> Sheet integration remains unimplemented. Keep legacy gateways stopped.

A stripped-down outbound-only SMS sender extracted from Nuntium.

## Architecture

Google Apps Script / lead automation
-> Supabase Edge Function `queue-enrollment-sms`
-> `sms_queue`
-> Android gateway
-> dedicated SIM
-> family

This starter intentionally excludes Nuntium's inbox UI, chatbot, auto-reply, organization/billing model, Chrome extension, and inbound SMS receiver.

## Safety / delivery rules

- One SMS segment only. The Edge Function checks GSM-7 length and the Android app verifies with Android `SmsManager.divideMessage()` before sending.
- Duplicate protection via `dedupe_key`.
- Queue rows are claimed atomically with `FOR UPDATE SKIP LOCKED`.
- Android authenticates with a one-time device token; the token is hashed in Postgres.
- The Android app uses a Supabase publishable/anon API key plus the separate device token. It never stores a service-role key.
- The Apps Script uses a custom ingest secret to call the Edge Function. It never receives the service-role key.
- Failed messages stay visible in `sms_queue` with `last_error`.

## Phase 3A producer API

The [Phase 3A contract and cutover guide](docs/PHASE3A_PRODUCER_API.md) adds atomic
frozen-payload dedupe receipts and a minimal, client-scoped `sms-queue-status`
endpoint. Same key/payload returns the original queue ID and current state; changed
payload returns 409. A stable dedupe key is required. Status uses a separate read
secret; service-role credentials remain server-side. The backend is deployed and stopped production smoke tests passed; the Sheet
producer remains disabled. Phase 3B CRM installation is tracked separately below.

## New Supabase project setup

1. Create a separate Supabase project, independent of Nuntium.
2. For a new empty database, use the [bootstrap and forward migrations](supabase/tests/README.md).
   The dedicated project already has Phase 1 and Phase 3A; do not replay those migrations.
3. Provision the Android identity using `create_sms_device` only when setting up a
   genuinely new handset. Store its returned token privately; do not replace the
   existing validated handset token during API cutover.
4. Follow the [producer cutover procedure](docs/PHASE3A_PRODUCER_API.md#cutover-procedure)
   to bind a disabled ingest client to the intended device, configure the ingest/read
   secrets and client ID, and deploy both Edge Functions with custom authentication.
   Leave producers and the gateway stopped until rollout is authorized.

## Android setup

Open `android-sms-gateway` in Android Studio and build/install the APK on the dedicated phone.

In the app enter:
- Supabase URL
- Supabase publishable key (legacy anon key also works)
- Device token returned by `create_sms_device`
- Poll interval (default 5 seconds)

**Test connection** only performs heartbeat; it does not save or start sending.
**Save and verify profile** binds the journal to the verified device and project.
A separate **Start one-hour gateway session** button explicitly starts sending.
Do not press Start until a controlled physical-device test is separately authorized.
Stop retains saved outcomes and allows reporting to continue. Reopening after process
death never resumes submission automatically. Unknown outcomes require investigation.

Build with JDK 17 and Android SDK 35:

```sh
cd android-sms-gateway
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The Gradle wrapper, distribution checksum and resolved dependency versions are pinned.
Tests use fake SMS transport and do not send real messages.

## CRM-integrated SMS (Phase 3B)

One controlled CRM SMS passed through physical receipt and Sheet status writeback.
The producer is disabled and handset stopped. The latest review has 77 passing
local tests; performance updates still need manual Apps Script installation and
stopped validation. See [review](docs/validation/PHASE3B_REVIEW.md) and
[test evidence](docs/validation/PHASE3B_FIRST_CRM_SMS_RESULT.md).


The implementation lives inside the existing Ednovate CRM and Apps Script project.
[Installation, exact schema and AUTO rollout](docs/PHASE3B_IMPLEMENTATION.md)
describe the two new SMS tabs and appended fields in existing tabs. All SMS logic
is installed as one `SmsIntegration.gs` bundle; existing email files have narrow
Both compatibility changes. LeadIntake remains unchanged.

The producer remains disabled. Manual source installation and stopped runtime
validation are in progress; see [validation gates](docs/validation/PHASE3B_STOPPED_VALIDATION.md).
Do not run the historical `google-apps-script/EnrollmentSms.gs` test helper.
Credentials belong only in Script Properties; no service-role key or handset token.

## Validation

Run [producer and database tests](supabase/tests/README.md) without a live gateway.
Physical Section A and the first controlled Section B send are already preserved
in `docs/validation/`. Additional real sends require separate authorization.
