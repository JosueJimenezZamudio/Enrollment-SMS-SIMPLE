# Enrollment SMS Starter

> **Phase 2 Android implementation:** The new client uses the Phase 1 attempt
> protocol and a durable SQLite journal. Keep legacy gateways stopped. This
> client has local build/fake-transport test coverage but is not yet approved
> for operational sending. No real SMS has been sent during this work.
> See [RPC/cutover](docs/PHASE1_RELIABILITY.md) and
> [Android validation and rollout](docs/PHASE2_ANDROID_IMPLEMENTATION.md).

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

## New Supabase project setup

1. Create a separate Supabase project.
2. For a new empty database, use the [bootstrap and forward migrations](supabase/tests/README.md). The dedicated project already has these migrations; do not replay them.
3. Deploy `supabase/functions/queue-enrollment-sms/index.ts` with JWT verification disabled because the function implements its own `x-enrollment-sms-secret` authentication.
4. Set Edge Function secret `LEAD_SMS_INGEST_SECRET` to a long random value.
5. Create the Android device token in SQL:

```sql
select * from public.create_sms_device('Enrollment Android', '+1XXXXXXXXXX');
```

Copy the returned `device_token` immediately. Only its hash is stored.

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

## Google Apps Script setup

Copy `google-apps-script/EnrollmentSms.gs` into the lead-automation Apps Script project.

Set Script Properties:
- `SMS_EDGE_FUNCTION_URL` = `https://<project-ref>.supabase.co/functions/v1/queue-enrollment-sms`
- `SMS_INGEST_SECRET` = the same value as `LEAD_SMS_INGEST_SECRET`

Then call:

```javascript
queueEnrollmentSms_({
  phone: row.phone,
  message: 'Thanks for your interest in USC East! Complete your application here: ...',
  leadId: row.id,
  eventType: 'initial_interest_form',
  dedupeKey: 'initial_interest_form:' + row.id
});
```

## First test

Future controlled-device checks, only after explicit authorization (not performed in Phase 2):

1. Install the Android app.
2. Create the device token.
3. Verify and save the profile, then explicitly start a bounded session.
4. Call the Edge Function with your own phone number.
5. Confirm the row moves `queued -> claimed -> sending -> sent`.
6. Only then connect the existing lead automation.
