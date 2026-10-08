# AGENTS.md

## Mission

You are working on **Enrollment-SMS-SIMPLE**, a deliberately small outbound SMS transport service for enrollment/recruitment automation.

Your job is to make this system reliable, secure, understandable, and easy to operate without turning it back into the larger Nuntium platform it was extracted from.

Read `PROJECT_HANDOFF.md` before making architectural changes.

---

## Core architecture

The expected flow is:

```text
Lead automation / Google Apps Script
        ->
Supabase Edge Function
        ->
sms_queue
        ->
Dedicated Android gateway
        ->
Dedicated SIM
        ->
Recipient
```

The three implementation areas are:

- `supabase/`
- `android-sms-gateway/`
- `google-apps-script/`

Keep boundaries between them clear.

---

## Mandatory first steps for every substantial task

Before editing:

1. Read `PROJECT_HANDOFF.md`.
2. Inspect the files relevant to the requested change.
3. Check `git status` and current branch.
4. Search for existing implementations before adding new code.
5. Determine whether the task affects:
   - Supabase schema/security,
   - Edge Functions,
   - Android SMS behavior,
   - Apps Script,
   - or more than one layer.
6. State or infer the test plan before implementation.
7. Never assume production infrastructure exists just because code exists in the repo.

Do not rewrite unrelated code.

---

## Absolute project constraints

Unless the user explicitly changes scope:

### Keep this project independent from Nuntium

Do not:

- import code directly from the Nuntium repository at runtime,
- point this project at the Nuntium Supabase project,
- share Nuntium tables,
- share Nuntium queues,
- share device tokens,
- modify Nuntium deployments,
- add Nuntium chatbot/inbox code.

Historical extraction from Nuntium is fine. Runtime coupling is not.

### Outbound-only

Do not add inbound SMS permissions, receivers, storage, auto-replies, or conversational behavior unless explicitly requested.

### One SMS segment only

The current product requirement is one segment.

Preserve validation in both places:

- Edge Function,
- Android gateway.

Do not silently truncate a message.

Do not automatically split or send multipart SMS.

Reject/flag instead.

### Dedicated physical Android + SIM

The Android phone is the SMS transport.

Do not replace this with Twilio, Telnyx, MessageBird, AWS SNS, or another provider unless the user explicitly asks to change transport.

---

## Security rules

### This repository may be public

Assume all committed content is visible to the public.

Never commit:

- Supabase service-role keys,
- Supabase secret keys,
- raw Android device tokens,
- `LEAD_SMS_INGEST_SECRET`,
- `SMS_INGEST_SECRET`,
- real passwords,
- OAuth credentials,
- private keys,
- production phone lists,
- student/family data,
- copied environment dumps,
- screenshots containing credentials.

Use placeholders in docs.

If a secret is found in Git history or source, stop and flag it.

### Supabase service role

The service-role credential belongs only in secure server-side Supabase Edge Function environment configuration.

Never send it to:

- Android,
- Apps Script,
- browser code,
- README examples,
- logs.

### Android auth

Android uses:

- a Supabase publishable/legacy anon API key for the API gateway, and
- a separate application device token.

The raw device token should be treated as a password.

### Database permissions

Do not grant direct `anon` or `authenticated` access to the underlying queue/device/log tables as a shortcut.

Device access should remain RPC-based.

### SECURITY DEFINER

Treat every `SECURITY DEFINER` function as security-sensitive.

When changing one:

- use an explicit safe `search_path`,
- authenticate/authorize inside the function,
- restrict affected rows,
- review grants,
- do not expose broad arbitrary data access,
- run Supabase security advisors.

Do not add `SECURITY DEFINER` merely to make a permission error disappear.

---

## Supabase development rules

When a task involves Supabase:

1. Verify current Supabase documentation before relying on remembered behavior.
2. Inspect the current project/schema before changing it.
3. Prefer migration-driven schema changes.
4. Keep RLS enabled on exposed-schema tables.
5. Keep grants minimal.
6. Test every new/changed RPC.
7. Run security advisors after DDL/security changes.
8. Run performance advisors when indexes/query patterns change.
9. Verify actual behavior; do not mark a fix complete based only on SQL review.

### Current core tables

```text
public.sms_devices
public.sms_queue
public.sms_send_log
```

### Current device RPC surface

```text
device_heartbeat
device_claim_sms_queue
device_mark_sms_sent
device_mark_sms_failed
```

### Device token helpers

```text
hash_sms_device_token
require_sms_device
create_sms_device
```

Do not rename RPCs casually because the Android client depends on exact names and parameter contracts.

If an RPC signature changes, update Android in the same change.

---

## Migration rules

The existing baseline file is:

```text
supabase/migrations/001_enrollment_sms.sql
```

If the project has already been deployed to a real Supabase database, do not rewrite deployed history casually.

Add a new migration for forward changes.

If the baseline has never been deployed and the user explicitly wants cleanup before first deployment, editing the initial migration may be acceptable, but confirm actual deployment state first.

Do not invent claims about what is already deployed.

---

## Edge Function rules

Path:

```text
supabase/functions/queue-enrollment-sms/index.ts
```

Responsibilities should stay narrow:

- authenticate ingest request,
- validate input,
- normalize phone,
- enforce one-segment policy,
- insert idempotently into queue,
- return useful HTTP status.

Do not make this function send SMS directly.

Do not put lead business logic here unless explicitly requested.

### Authentication

Current custom header:

```text
x-enrollment-sms-secret
```

Expected environment variable:

```text
LEAD_SMS_INGEST_SECRET
```

If changing authentication, update:

- Edge Function,
- Apps Script,
- README,
- PROJECT_HANDOFF.md,
- deployment instructions.

### Phone normalization

Current behavior is intentionally US-only.

Accepted forms normalize to:

```text
+1XXXXXXXXXX
```

Do not quietly add international behavior without tests and explicit requirements.

### GSM-7

Preserve correct septet counting.

GSM extension characters consume two septets.

Add tests if changing the character tables or segment logic.

---

## Android development rules

The Android application is intentionally plain and dependency-light.

Current package:

```text
com.enrollmentdesk.enrollmentsms
```

Do not change package/application ID unless there is a reason and migration plan.

### Required behavior

The gateway must:

- run as a foreground service,
- heartbeat,
- claim queue rows,
- pace sends,
- verify one segment with `SmsManager.divideMessage()`,
- persist callback mapping,
- send with `SmsManager`,
- report sent/failed status.

### Do not add inbound SMS

Do not request `RECEIVE_SMS`.

Do not add a `SMS_RECEIVED` receiver.

### SMS semantics

Do not call a successful Android send callback “delivered” or “read.”

Use “sent” unless actual carrier delivery receipts are implemented.

### Pacing

Current minimum send interval:

```text
10 seconds
```

Treat pacing as a safety constraint.

Do not reduce it without explicit approval and real-device testing.

### Polling

Current configuration allows:

```text
5–60 seconds
```

default 5 seconds.

Avoid extremely aggressive polling.

### Error handling

Do not make the service crash on transient backend failures.

However, do not hide actionable errors completely.

Prefer safe structured diagnostics that exclude message contents, secrets, and sensitive contact data.

### Real-device verification

Changes to:

- `SmsManager`,
- foreground service lifecycle,
- callbacks,
- permissions,
- queue timing,
- Android version behavior

must be considered incomplete until tested on a physical Android phone when feasible.

An emulator is not sufficient for final SMS transport verification.

---

## Google Apps Script rules

Path:

```text
google-apps-script/EnrollmentSms.gs
```

Apps Script is only a client/bridge.

Keep it small.

Do not put the Supabase service-role key in Script Properties.

Only use the ingest secret needed to call the Edge Function.

### Idempotency

Production callers should supply stable semantic `dedupeKey` values.

Good:

```text
initial_interest_form:<lead-id>
eis_reminder:<event-id>:<lead-id>
application_reminder:<cycle>:<lead-id>
```

Bad:

```text
initial_interest_form:<current timestamp>
```

because a retry would get a different key and send twice.

---

## Queue state-machine rules

Current states:

```text
queued
claimed
sent
failed
cancelled
```

Normal path:

```text
queued -> claimed -> sent
```

Failure path:

```text
queued -> claimed -> failed
```

Do not create ambiguous transitions without documenting them.

If adding retry/recovery, design state transitions explicitly.

### Critical duplicate-send warning

A stale `claimed` message is not automatically safe to resend.

It may have been handed to Android before the process lost connectivity.

Any recovery feature must account for this ambiguity.

Never implement a cron that blindly changes all old `claimed` rows back to `queued`.

---

## Dedupe rules

`sms_queue.dedupe_key` is the main idempotency mechanism.

Keep the unique constraint.

A duplicate ingest request with the same dedupe key should not create a second send.

If changing dedupe behavior, test concurrent duplicate requests.

---

## Data minimization

Avoid storing unnecessary personal information.

The queue needs:

- phone,
- message body,
- optional external lead identifier,
- event type,
- timing/status metadata.

Do not copy entire student records into `metadata`.

Do not store DOB, addresses, grades, email history, or other unrelated attributes unless required for a specific approved feature.

---

## Logging rules

Never log:

- full device tokens,
- service-role keys,
- ingest secrets,
- Authorization headers,
- full student/family datasets.

Prefer identifiers and timing metadata.

Be cautious with SMS body logging; message content can contain sensitive information.

For production observability, IDs/status/timestamps are usually enough.

---

## Testing expectations

### Edge Function minimum tests

Test:

1. missing secret -> 401
2. wrong secret -> 401
3. non-POST -> 405
4. invalid JSON -> 400
5. invalid phone -> 400
6. empty message -> 400
7. non-GSM-7 -> 400
8. >160 septets -> 400
9. valid one-segment request -> 201
10. same dedupe key twice -> one row only and duplicate response

### Database minimum tests

Test:

1. invalid device token rejected
2. disabled device rejected
3. heartbeat updates device
4. only due queued rows are claimable
5. claim changes status atomically
6. two concurrent workers cannot claim same row
7. wrong device cannot mark another device's row sent
8. sent creates send-log row
9. failed creates send-log row

### Android minimum tests

Test:

1. configuration saves/reloads
2. bad backend config shows failure
3. heartbeat succeeds
4. one-part SMS is sent
5. multipart body is blocked
6. pacing is observed
7. successful callback marks sent
8. failed callback marks failed
9. foreground service survives normal screen-off/background use
10. reboot/battery optimization behavior is documented

---

## Build / validation discipline

Do not say “done” until the relevant validation has actually run.

Examples:

- SQL changed -> execute/test it, not just lint it.
- Edge Function changed -> invoke it.
- Android changed -> build it.
- SMS transport changed -> use physical-device test if available.
- Apps Script changed -> make a real test request or provide exact blocked dependency.

If a required external system is unavailable, state exactly what remains unverified.

---

## Code style

Favor straightforward code over abstractions.

This is a small infrastructure project, not a framework.

Prefer:

- descriptive names,
- explicit state transitions,
- small methods/functions,
- pinned dependencies,
- comments explaining safety-sensitive behavior,
- minimal dependencies.

Avoid:

- unnecessary DI frameworks,
- complex generic abstractions,
- hidden magic,
- premature multi-tenant architecture,
- introducing a frontend unless requested.

---

## Documentation responsibilities

If a change affects setup or architecture, update documentation in the same PR.

At minimum consider:

- `README.md`
- `PROJECT_HANDOFF.md`
- this `AGENTS.md`

Examples that require documentation updates:

- new environment variable,
- new table,
- new RPC,
- new queue status,
- authentication change,
- Android permission change,
- changed pacing,
- retry/recovery behavior,
- deployment workflow.

---

## Git workflow

Keep commits focused.

Do not commit generated secrets or local machine files.

Prefer work on a feature branch for nontrivial changes.

Do not merge directly into unrelated repositories.

Do not touch Nuntium as part of ordinary work here.

Before finishing:

1. inspect diff,
2. verify no secrets,
3. run tests/builds,
4. summarize files changed,
5. summarize validation performed,
6. call out anything still requiring manual/device verification.

---

## Production safety

This system can send real SMS from a real phone number.

Treat any code path that queues or sends messages as a side-effecting production action.

When testing:

- use controlled test numbers first,
- do not run bulk tests against real lead lists,
- keep volume low,
- verify dedupe behavior,
- verify the dedicated SIM/device is the intended sender.

Do not create a mass-send path as a convenience without explicit approval and safety controls.

---

## Current priorities

Unless the user asks for something else, engineering priority should be:

1. finish dedicated Supabase setup,
2. validate/harden schema and RPC security,
3. build Android successfully,
4. complete physical-device heartbeat,
5. complete first controlled SMS,
6. complete negative/idempotency tests,
7. connect the actual lead automation,
8. design safe stuck-claim recovery,
9. improve observability,
10. only then add optional features.

---

## Known unresolved reliability issue

The most important architectural gap is recovery of queue rows stuck in `claimed`.

Do not “fix” this by blindly requeueing old claimed rows.

A message can be in an uncertain state:

```text
DB says claimed
but Android may already have called sendTextMessage
```

A correct design should track enough state to distinguish:

- claim obtained,
- send attempt started,
- Android callback received,
- status RPC confirmed.

Prefer an explicit attempt/lease model or another dedupe-safe mechanism.

Discuss the design before implementing destructive recovery.

---

## When requirements are ambiguous

Prefer the smallest change that preserves:

- separation from Nuntium,
- one-segment SMS,
- dedicated Android/SIM transport,
- queue idempotency,
- security boundaries.

Do not expand product scope based on assumption.

---

## Definition of a good Codex response

For implementation tasks, report:

- what you found,
- what you changed,
- why,
- files changed,
- tests/verification run,
- any remaining manual steps,
- any risk or assumption.

Do not claim infrastructure is deployed, an SMS was sent, or a fix was verified unless you actually verified it.

---

## Final reminder

The core product is intentionally simple:

```text
authorized request
-> validated one-segment queue item
-> dedicated Android claims it
-> physical SIM sends it
-> outcome is recorded
```

Protect that simplicity.
