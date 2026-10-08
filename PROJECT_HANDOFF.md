# PROJECT_HANDOFF.md

## 1. Project identity

**Repository:** `JosueJimenezZamudio/Enrollment-SMS-SIMPLE`  
**Purpose:** A small, standalone outbound SMS delivery system for enrollment/recruitment lead automation.  
**Current status:** Source code has been extracted from the larger Nuntium project and placed in this dedicated repository. The code is not yet connected to a dedicated Supabase production project, and the Android gateway has not yet been production-tested from this repository.

This project is intentionally independent from Nuntium. Do not reintroduce Nuntium's inbox, chatbot, organization/billing model, Chrome extension, inbound SMS handling, or web dashboard unless the product scope explicitly changes.

The intended production system is:

```text
Enrollment lead automation / Google Apps Script
                |
                v
Supabase Edge Function: queue-enrollment-sms
                |
                v
          public.sms_queue
                |
                v
      Dedicated Android device
                |
                v
        Dedicated phone/SIM
                |
                v
              Family
```

The project should remain simple. The main goal is reliable, auditable delivery of short one-segment SMS messages from a dedicated Android phone.

---

## 2. Why this repository exists

The SMS transport logic originally came from `Nuntium-Gateway`. The useful transport pieces were extracted and simplified so enrollment messaging could run on:

- a separate GitHub repository,
- a separate Supabase project,
- a separate Android application package,
- a separate Android device,
- a separate SIM/phone number,
- and a separate message queue.

The separation is deliberate. A bug, deployment, schema change, or credentials change in this project must not affect Nuntium.

Do not make changes to `Nuntium-Gateway` as part of work on this repository unless the user explicitly asks for a cross-project change.

---

## 3. Product scope

### In scope

The current product is responsible for:

1. Receiving an outbound SMS request from an authorized lead automation.
2. Validating the destination US phone number.
3. Validating that the message is one GSM-7 SMS segment.
4. Preventing duplicate queue insertion when a `dedupe_key` is supplied.
5. Inserting the outbound message into Supabase.
6. Allowing a dedicated Android device to authenticate using a device token.
7. Atomically claiming due queue rows.
8. Sending SMS through Android `SmsManager`.
9. Enforcing a second one-segment check on the Android device.
10. Pacing sends so messages are not fired back-to-back.
11. Marking messages sent or failed.
12. Keeping a send log for audit/debugging.
13. Reporting device heartbeat metadata.

### Explicitly out of scope unless requested

Do not add these by default:

- inbound SMS ingestion,
- two-way conversations,
- AI-generated replies,
- chatbot state or memory,
- OpenAI calls,
- Nuntium inbox UI,
- contact/CRM UI,
- billing,
- multi-tenant organizations,
- authentication UI,
- Chrome extensions,
- Vercel web deployment,
- bulk marketing campaign builder,
- multipart SMS,
- MMS,
- WhatsApp,
- Twilio or other SMS providers.

The guiding principle is: **keep the transport layer small and dependable.**

---

## 4. Repository layout

```text
Enrollment-SMS-SIMPLE/
├── README.md
├── PROJECT_HANDOFF.md
├── AGENTS.md
│
├── android-sms-gateway/
│   ├── build.gradle
│   ├── settings.gradle
│   └── app/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/enrollmentdesk/enrollmentsms/
│           │   ├── GatewayConfig.java
│           │   ├── MainActivity.java
│           │   ├── OutboxMessage.java
│           │   ├── PendingSendStore.java
│           │   ├── SmsGatewayService.java
│           │   ├── SmsSentReceiver.java
│           │   └── SupabaseGatewayClient.java
│           └── res/values/styles.xml
│
├── google-apps-script/
│   └── EnrollmentSms.gs
│
└── supabase/
    ├── functions/
    │   └── queue-enrollment-sms/
    │       └── index.ts
    └── migrations/
        └── 001_enrollment_sms.sql
```

---

## 5. End-to-end data flow

### Step 1: enrollment automation decides a text should be sent

The existing lead automation will eventually call:

```javascript
queueEnrollmentSms_({
  phone: row.phone,
  message: '...',
  leadId: row.id,
  eventType: 'initial_interest_form',
  dedupeKey: 'initial_interest_form:' + row.id,
  scheduledAt: new Date().toISOString()
});
```

The business rules deciding *who* should receive a message and *when* should remain upstream in the lead automation.

This SMS project should not duplicate the entire lead-decision engine.

### Step 2: Google Apps Script calls the Edge Function

`google-apps-script/EnrollmentSms.gs` sends an HTTPS POST to:

```text
https://<project-ref>.supabase.co/functions/v1/queue-enrollment-sms
```

It authenticates using:

```text
x-enrollment-sms-secret: <SMS_INGEST_SECRET>
```

The value is stored in Apps Script Script Properties.

### Step 3: Edge Function validates and queues

`supabase/functions/queue-enrollment-sms/index.ts`:

- accepts POST only,
- compares `x-enrollment-sms-secret` to `LEAD_SMS_INGEST_SECRET`,
- normalizes US phone numbers to `+1XXXXXXXXXX`,
- trims the message,
- rejects empty messages,
- calculates GSM-7 septets,
- rejects non-GSM-7 characters,
- rejects more than 160 septets,
- inserts into `public.sms_queue`,
- treats duplicate `dedupe_key` conflicts as an idempotent success.

### Step 4: Android gateway polls

The Android foreground service polls Supabase using RPC:

```text
device_claim_sms_queue
```

The Android app has:

- Supabase project URL,
- Supabase publishable key or legacy anon key,
- a separate one-time device token.

The device token is not the Supabase API key. It is application-level device authentication.

### Step 5: Postgres atomically claims queue rows

`device_claim_sms_queue` uses:

```sql
FOR UPDATE SKIP LOCKED
```

and changes a row from:

```text
queued -> claimed
```

while attaching the claiming device.

This prevents two devices from sending the same row if multiple workers ever exist.

### Step 6: Android sends

Before sending, Android calls:

```java
smsManager.divideMessage(message.body)
```

If Android determines the message has anything other than exactly one part, the message is blocked and marked failed.

If it is one part, Android sends through:

```java
smsManager.sendTextMessage(...)
```

### Step 7: Android callback reports status

`SmsSentReceiver` receives the Android send callback.

Successful result:

```text
claimed -> sent
```

Failure:

```text
claimed -> failed
```

A corresponding row is inserted into `sms_send_log`.

---

## 6. Database schema

The current schema is defined in:

```text
supabase/migrations/001_enrollment_sms.sql
```

### public.sms_devices

Purpose: records approved Android gateway devices.

Important columns:

- `id` UUID primary key
- `name`
- `phone`
- `token_hash`
- `enabled`
- `status`
- `last_seen_at`
- Android/app metadata
- `metadata` JSONB

The raw device token is not stored. Only its SHA-256 hash is stored.

### public.sms_queue

Purpose: authoritative outbound queue.

Important columns:

- `id`
- `lead_id`
- `to_phone`
- `body`
- `event_type`
- `dedupe_key`
- `status`
- `scheduled_at`
- `claimed_at`
- `sent_at`
- `failed_at`
- `attempts`
- `last_error`
- `device_id`
- `claimed_by`
- `metadata`
- timestamps

Current statuses:

```text
queued
claimed
sent
failed
cancelled
```

### public.sms_send_log

Purpose: append-style record of final send/failure events.

Important columns:

- `queue_id`
- `device_id`
- `status`
- `sms_message_id`
- `error`
- `metadata`
- `occurred_at`

---

## 7. Database functions / RPCs

### hash_sms_device_token(text)

Hashes a raw device token with SHA-256.

### require_sms_device(text)

Looks up an enabled device by token hash. Raises if invalid or disabled.

### create_sms_device(name, phone)

Generates a random 32-byte token represented in hex, stores its hash, and returns the raw token once.

Expected setup call:

```sql
select * from public.create_sms_device(
  'Enrollment Android',
  '+1XXXXXXXXXX'
);
```

The returned raw `device_token` must be copied immediately and entered into the Android app.

### device_heartbeat(...)

Updates:

- online status,
- `last_seen_at`,
- app version,
- Android version,
- manufacturer,
- model,
- metadata.

### device_claim_sms_queue(device_token, limit)

Claims due rows.

Current upper bound: 10 rows per RPC.

Current Android caller requests 3.

### device_mark_sms_sent(...)

Changes a claimed queue row to `sent` and writes a `sms_send_log` row.

### device_mark_sms_failed(...)

Changes a claimed queue row to `failed` and writes a `sms_send_log` row.

---

## 8. Security model

This project handles phone numbers and outbound messaging, so security changes must be conservative.

### Repository visibility

At the time of handoff, the GitHub repository is **public**.

Therefore:

**Never commit any real secrets, phone credentials, service-role keys, Supabase secret keys, device tokens, Apps Script secrets, or production data to this repository.**

If repo visibility later changes, still follow the same rule.

### Supabase roles

The three database tables have RLS enabled.

Direct table access is revoked from:

- `anon`
- `authenticated`

The server-side Edge Function uses the Supabase service-role credential from the Edge Function environment.

The Android app does **not** use the service role.

Android uses:

1. a Supabase publishable key / legacy anon key for API gateway access, plus
2. the separate device token consumed by the RPC.

### SECURITY DEFINER

The device RPCs use `SECURITY DEFINER`.

Any changes to these functions require extra review because `SECURITY DEFINER` bypasses normal RLS behavior.

Do not broaden their privileges casually.

Maintain all of the following properties:

- explicit device-token validation,
- constrained queries,
- fixed `search_path`,
- minimal grants,
- no arbitrary SQL,
- no ability for a device to directly read all queue data.

### Edge Function secret

The Edge Function currently uses a custom shared secret header because Google Apps Script is not using Supabase Auth.

Environment variable:

```text
LEAD_SMS_INGEST_SECRET
```

Request header:

```text
x-enrollment-sms-secret
```

Apps Script property:

```text
SMS_INGEST_SECRET
```

These two secret values must match.

### Service-role credential

`SUPABASE_SERVICE_ROLE_KEY` is read only inside the Edge Function environment.

It must never be:

- committed,
- placed in Apps Script,
- placed in Android,
- printed to logs,
- returned in HTTP responses.

---

## 9. SMS segment policy

This is a core product requirement.

**The system currently supports exactly one GSM-7 SMS segment per outbound message.**

### Server-side check

The Edge Function computes GSM-7 septets.

Rules:

- GSM-7 basic characters use one septet.
- GSM-7 extension characters use two septets.
- non-GSM-7 characters are rejected.
- more than 160 septets are rejected.

This means emoji, curly punctuation, many non-English characters, and other Unicode characters may be rejected.

### Device-side check

Android independently calls:

```java
SmsManager.divideMessage(...)
```

Anything not equal to exactly one part is marked failed.

The dual check is intentional:

- server validation gives fast feedback,
- Android validation is the final carrier/device-side guardrail.

Do not silently allow multipart SMS unless the product owner explicitly changes this requirement.

---

## 10. Duplicate prevention / idempotency

`sms_queue.dedupe_key` has a unique constraint.

The Edge Function treats Postgres unique violation `23505` as a successful duplicate response when a dedupe key is supplied.

Recommended dedupe patterns:

```text
initial_interest_form:<lead-id>
event_reminder:<event-id>:<lead-id>
application_reminder:<cycle>:<lead-id>
```

A retry by Apps Script should not send a duplicate if it uses the same semantic dedupe key.

Avoid timestamp-based dedupe keys for production business events because they defeat idempotency.

---

## 11. Send pacing

The Android gateway currently has:

```java
MIN_SEND_INTERVAL_MS = 10_000L
```

So send attempts are separated by at least 10 seconds within the running service process.

The service currently claims up to 3 queue rows per polling cycle.

This is intentionally conservative.

Do not reduce or remove pacing without testing on the actual device/SIM and considering carrier behavior.

---

## 12. Android application

### Package

```text
com.enrollmentdesk.enrollmentsms
```

This is separate from the original Nuntium package.

### Minimum / target

Current Gradle settings:

- `minSdk 26`
- `targetSdk 35`
- `compileSdk 35`
- version `1.0.0`

### Permissions

Current manifest requests:

- INTERNET
- ACCESS_NETWORK_STATE
- FOREGROUND_SERVICE
- FOREGROUND_SERVICE_DATA_SYNC
- POST_NOTIFICATIONS
- SEND_SMS

There is intentionally no `RECEIVE_SMS` permission and no inbound SMS receiver.

### GatewayConfig.java

Stores configuration in Android SharedPreferences:

- Supabase URL
- API key
- device token
- poll interval
- enabled flag

Poll interval allowed range:

```text
5 to 60 seconds
```

default:

```text
5 seconds
```

### MainActivity.java

Provides a minimal configuration UI for:

- URL
- API key
- device token
- poll interval
- enable/disable
- Test Connection

No general-purpose inbox UI is planned.

### SmsGatewayService.java

Foreground service responsible for:

- polling,
- heartbeat,
- queue claim,
- pacing,
- one-segment device check,
- sending SMS.

### PendingSendStore.java

Persists minimal pending callback context in SharedPreferences keyed by request code so the send receiver can map an Android callback to a queue row.

### SmsSentReceiver.java

Processes Android send result and reports sent/failed status to Supabase.

### SupabaseGatewayClient.java

Makes direct HTTPS calls to PostgREST RPC endpoints.

Current RPC names:

```text
device_heartbeat
device_claim_sms_queue
device_mark_sms_sent
device_mark_sms_failed
```

---

## 13. Google Apps Script integration

File:

```text
google-apps-script/EnrollmentSms.gs
```

Required Script Properties:

```text
SMS_EDGE_FUNCTION_URL
SMS_INGEST_SECRET
```

The Apps Script helper accepts:

```javascript
{
  phone,
  message,
  leadId,
  eventType,
  dedupeKey,
  scheduledAt
}
```

The current file also contains:

```javascript
testEnrollmentSms_()
```

The placeholder phone must be replaced before testing.

Do not put a production secret directly into source code.

---

## 14. Supabase Edge Function

Path:

```text
supabase/functions/queue-enrollment-sms/index.ts
```

Current dependency:

```text
@supabase/supabase-js 2.57.4
```

The version is pinned intentionally.

The function is expected to be deployed with Supabase JWT verification disabled **only because the function performs its own custom shared-secret authentication**.

Do not remove custom authentication.

If migrating later to a stronger signed request or Supabase-authenticated service account, update this document and the Apps Script integration together.

---

## 15. Production setup that has NOT happened yet

At handoff, do not assume these steps are complete.

### Not yet confirmed

- dedicated Supabase project created,
- migration applied to that project,
- Edge Function deployed,
- `LEAD_SMS_INGEST_SECRET` configured,
- dedicated Android device row created,
- Android APK built from this repo,
- APK installed on the dedicated phone,
- Supabase URL/API key/device token entered,
- real heartbeat verified,
- test queue row sent,
- end-to-end Apps Script test completed,
- integration with the real lead-email automation completed,
- production retry/recovery behavior tested,
- carrier/device battery optimization behavior tested.

Codex should verify actual state before assuming any of these have happened.

---

## 16. Recommended setup sequence

When continuing implementation, use this order.

### Phase A — repository sanity

1. Inspect the full repository.
2. Read `AGENTS.md`.
3. Run a secret scan / search for accidental credentials.
4. Add a sensible `.gitignore` if one does not exist.
5. Confirm the Android project builds or identify missing Gradle wrapper/tooling.

### Phase B — dedicated Supabase project

1. Create/select a Supabase project used only by this repository.
2. Apply the schema in `001_enrollment_sms.sql`.
3. Run Supabase security and performance advisors.
4. Verify RLS and grants.
5. Verify the RPC signatures through actual calls.
6. Deploy `queue-enrollment-sms`.
7. Configure `LEAD_SMS_INGEST_SECRET`.
8. Verify unauthorized requests return 401.
9. Verify authorized one-segment requests create exactly one queue row.
10. Verify duplicate dedupe keys do not create a second row.

### Phase C — Android

1. Build APK.
2. Install on dedicated Android device.
3. Grant SMS and notification permissions.
4. Create a device with `create_sms_device`.
5. Enter project URL, publishable key, and device token.
6. Tap Test Connection.
7. Confirm `sms_devices.last_seen_at` updates.
8. Enable gateway.

### Phase D — first controlled send

Use the owner's own test phone number first.

Verify:

```text
queued -> claimed -> sent
```

Verify a `sms_send_log` row exists.

Verify the physical SMS arrived from the dedicated SIM.

### Phase E — negative tests

Test:

- invalid phone,
- empty body,
- non-GSM-7 body,
- >160 septets,
- duplicate dedupe key,
- bad ingest secret,
- bad device token,
- disabled device,
- Android message that resolves to multiple parts,
- Android send failure.

### Phase F — lead automation integration

Only after the isolated pipeline is proven should the actual lead automation call `queueEnrollmentSms_()`.

---

## 17. Known engineering gaps / items to review

These are not necessarily bugs, but should be reviewed before production.

### A. No claimed-row lease timeout / recovery

A queue row can become `claimed` and remain there if the phone process dies after claim but before marking sent/failed.

Before production scale, design a safe stale-claim recovery policy.

Do not blindly requeue claimed rows because an SMS may have been handed to Android/carrier already, creating duplicate-send risk.

A recovery design should distinguish:

- claimed but never attempted,
- attempted with unknown callback,
- callback completed but Supabase update failed.

### B. Callback persistence limitations

`PendingSendStore` helps persist callback mapping, but lifecycle/reboot behavior should be tested thoroughly.

### C. Error swallowing

Some Android exceptions are intentionally ignored to keep the foreground service alive.

For production debugging, consider safe structured local logging and/or a device-event reporting mechanism, but never log message bodies or secrets unnecessarily.

### D. No delivery receipt

Current `sent` means Android's send callback returned success, not that the recipient handset definitively received/read the SMS.

Use accurate terminology in UI/logging.

### E. US-only phone normalization

The Edge Function currently accepts only:

- 10-digit US numbers, or
- 11-digit numbers beginning with 1.

Do not assume international support.

### F. Consent / opt-out rules are upstream

This transport service currently does not model consent, STOP keywords, or enrollment-contact preferences.

Any automated real-world messaging workflow must ensure the upstream lead automation only queues contacts that the organization is permitted to message.

If opt-out handling is later needed in this repository, it needs an explicit product design because the current system is outbound-only and does not read replies.

### G. Public repository

Again: this repository is public at handoff. Treat every committed byte as public.

---

## 18. Recommended future improvements

Prioritize reliability before features.

Suggested order:

1. stale-claim recovery design,
2. Android instrumentation / safe diagnostic events,
3. build automation / CI,
4. unit tests for GSM-7 and phone normalization,
5. Edge Function request tests,
6. database/RPC integration tests,
7. controlled retry tooling,
8. queue observability,
9. configuration health checks,
10. only then broader automation features.

A dashboard is not required for MVP.

---

## 19. Definition of MVP complete

MVP is complete when all of the following are true:

- dedicated Supabase project exists,
- schema applied cleanly,
- security advisors reviewed,
- Edge Function deployed,
- custom ingest secret configured,
- dedicated Android phone has a valid device token,
- gateway heartbeat works,
- one-segment test SMS queues,
- Android claims it,
- physical SMS is sent from the dedicated SIM,
- queue row becomes `sent`,
- send log row is created,
- duplicate request does not create a duplicate send,
- invalid/multipart messages are blocked,
- real lead automation can enqueue a controlled test contact,
- Nuntium is not touched by any of this.

---

## 20. Definition of done for code changes

A change is not done merely because the code compiles.

For changes affecting Supabase:

- apply/test against the intended project or local environment,
- run relevant advisors,
- verify RLS/grants,
- verify RPC/function behavior,
- document any new secret or environment variable.

For Android:

- build successfully,
- test on a real Android device when the change affects SMS behavior,
- verify queue transitions,
- verify no multipart regression.

For Apps Script:

- test the actual HTTP request,
- confirm retries remain idempotent,
- never expose secrets in logs.

---

## 21. High-value invariants

Codex should preserve these unless explicitly instructed otherwise:

1. Enrollment SMS remains independent from Nuntium.
2. Service-role keys never reach Android or Apps Script.
3. Raw device tokens are not stored server-side.
4. Direct table access for anon/authenticated stays closed.
5. Android device RPCs validate the device token.
6. One SMS segment maximum.
7. Queue claims are atomic.
8. Duplicate business events can be made idempotent with `dedupe_key`.
9. Dedicated Android device/SIM performs actual sending.
10. No hidden migration toward Twilio or another provider without user approval.
11. No inbound/AI/chatbot scope creep.
12. Do not merge secrets or production data into Git.

---

## 22. Context for Codex

The owner is using Codex to continue engineering work and may ask it to:

- finish Supabase setup,
- harden the schema,
- build/test the Android gateway,
- integrate with the lead-email automation,
- diagnose queue or send failures,
- add reliable recovery,
- write deployment/setup documentation.

Codex should treat this file as project history and architecture context, not as a substitute for inspecting the current code.

**Always inspect the repository and current Supabase state before making changes.**
