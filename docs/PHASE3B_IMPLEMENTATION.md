# Phase 3B CRM implementation and stopped installation

Status: local implementation tested; user is installing the code manually in the existing Apps Script project. Complete saved-source readback and stopped runtime validation before merging or enabling anything. No new workbook, no new web-app URL, no Android changes.

## SMS boundary

Install `google-apps-script/dist/SmsIntegration.gs` as **one** file in the existing project. Its four source modules under `google-apps-script/crm/Sms*.gs` are repository organization only; do not install both the bundle and modules. Rebuild with `node google-apps-script/tools/build-sms-bundle.cjs`.

All SMS policy, AUTO/MANUAL approval, rendering checks, frozen requests, journal, transport, retries and polling are inside that bundle. No onEdit handler or intake path submits SMS. The worker reconciles existing Master Leads using stable IDs, source timestamps and a fixed first-seen boundary. Existing leads are not retroactively welcomed.

The original five files are preserved in `google-apps-script/tests/baseline`. `LeadIntake.gs` is byte-for-byte unchanged. Existing email checks in EmailAutomation, WelcomeEmailImmediate_v3 and SquarespaceWebHook accept Email or Both without calling any SMS helper. The email log append shares the existing ScriptLock to prevent competing writers selecting the same row. CampaignEngine has explicit SMS menu/preview hooks and writes 20 preview columns. Original email delivery keys, statuses, routing, templates, opt-out and welcome guards remain intact.

## Workbook installation

Enable Google Sheets API v4 under Apps Script Services first (for a standard Cloud project, also enable the API in that project). Run `diagnoseSmsSheetAccess` and require HTTP 200. Run `installSmsCrmPaused` only after source verification. This creates exactly SMS Outbox and SMS Submission Log, appends the schema below, adds missing SMS Settings keys, records the cutover boundary, assigns persistent household Business Lead IDs and defaults SMS Permission to Unknown. It does not create a trigger or submit to Supabase. Re-running does not reset the cutover boundary or authorize history.

The installer preserves existing column positions and existing Settings values. Existing SMS switches remain FALSE; SMS_ENGINE_MODE is PREVIEW_ONLY, SMS_AUTO_ENABLED FALSE, SMS_PAUSED TRUE, SMS_ROLLOUT_MODE ALLOWLIST with an empty allowlist. New SMS ranges are protected for the installer/operator. Existing email columns and trigger ownership remain unchanged. The journal is append-only in application code and protected from ordinary editors; a spreadsheet owner can still alter it, so it is not tamper-proof storage.

## Script Properties

Installer-managed: SMS_OPERATOR_EMAIL, SMS_EXPECTED_CRM_ID, SMS_BASELINE_AT, SMS_SCHEMA_READY. Worker-managed: SMS_PREPARE_CURSOR.

Before controlled rollout, the operator must privately configure SMS_API_BASE_URL to `https://rccdxrmyavihzdrgokpv.supabase.co/functions/v1`, SMS_INGEST_SECRET to the existing producer ingest secret, and SMS_STATUS_SECRET to the separate read secret. Never store credentials in cells, source, logs, or this repository. No service-role key or handset token belongs in Apps Script. The disabled server binding controls the dedicated handset; the Sheet does not select arbitrary devices.

## Approval and recovery

AUTO requires an explicitly armed campaign policy, approved unchanged SMS template, eligible canonical household lead, recorded SMS permission, allowed source, valid language, valid US phone, one GSM-7 segment, active rollout switches and allowlist membership. Custom messages, effective template overrides and row schedule overrides require MANUAL. Manual approval binds a preview fingerprint; editing its inputs invalidates it. Merely editing a cell does not invoke HTTP.

The journal records PREPARED with exact six-field request JSON and SHA-256 before HTTP. The dedupe identity hashes CRM ID, Business Lead ID, Campaign ID, Business Event Type, Event Instance and channel; clocks, content and row position never generate a new identity. Scheduled audiences are frozen once. Immediate scheduledAt is assigned once at preparation. All later HTTP retries use the stored string, not regenerated JSON.

Dispatch is reserved under ScriptLock, with a ten-minute lease persisted before network I/O. A crash after backend acceptance is reconciled by an identical ingest retry returning the existing queue ID. A status observation alone cannot prove payload equality and cannot replace that ingest acknowledgment. An ACCEPTED receipt is never submitted again, including unknown, failed or cancelled outcomes. Missing/corrupt snapshots stop execution. Deleted Outbox rows do not erase journal receipts or authorize a new queue item.

Submission state and backend state are independent. 401 pauses ingest; 409 stops that submission for review; ingest 400/unexpected responses require review; network/429/5xx use bounded backoff with the same bytes. A configuration-unavailable 503 pauses ingest. Read 404 means unavailable to this client, not proof that submission failed. Read failures retain prior receipts/status and mark sync stale. Status requests use queue ID plus dedupe key after acceptance, dedupe key before it, and validate the nine-field safe response. Unknown is polled slowly and never requeued by Apps Script. Backend sent means Android reported sent, not carrier delivery or a visible local handset ACK.

## Triggers and deployment

Preserve existing `runDueEmailCampaigns` and `handleOriginalFormSubmit` triggers. No SMS trigger is installed during stopped setup. Later, the designated operator runs `installSmsWorkerTrigger` once to create one one-minute time trigger for `runSmsWorker`. No additional onOpen trigger is needed. Existing onOpen only adds menus.

Saved editor code affects existing head-based triggers; it is not the same as a versioned web-app deployment. Preserve the existing deployment URL and authentication. Do not create a new endpoint or change Zapier/unsubscribe URLs. Since the Squarespace intake hook was deliberately removed, SMS reconciliation does not depend on redeploying the webhook. The small Both compatibility change in its email path still requires the existing web-app deployment to be updated and verified before enabling Both for that path.

## Controlled AUTO rollout — not authorized by installation

1. Finish source readback, run paused installer, then `validateStoppedSmsIntegration`. Verify appended schema, permissions, unchanged email settings/triggers and empty SMS tabs. Both unauthenticated endpoints must return 401. Check disabled producer and unchanged Section B evidence in Supabase.
2. Configure the three private API properties. Keep producer disabled and gateway stopped while reviewing configuration. Do not change any email switches.
3. Set ALLOWLIST to the explicitly authorized test recipient only. Use a real controlled test lead for that recipient; never redirect a family's message to a test number. Record its SMS permission/source.
4. Enter dynamic SMS bodies in existing Templates H/I; approve the SMS revision through SMS Tools. Set the intended campaign to SMS or Both, preserve email controls, assign stable business event type/instance, choose AUTO and explicitly arm its policy. Set a fixed future WELCOME_SMS_START_AT for welcome testing; historical records remain ineligible.
5. Under separate authorization, enable the scoped server binding and SMS switches, set SMS_ENGINE_MODE LIVE, SMS_AUTO_ENABLED TRUE, SMS_PAUSED FALSE, and install the single worker trigger. Start the validated handset session only when a controlled real send is authorized. AUTO then requires no per-row approval for eligible template rows.
6. Observe one business event through PREPARED, ACCEPTED, queued/claimed/sending/sent and status writeback. Confirm physical receipt and handset journal separately. Re-run the worker to verify no second queue item. Test MANUAL overrides separately.
7. Stop by setting SMS_PAUSED TRUE and disabling the producer. Remove only the SMS worker trigger if needed. HOLD prevents further POSTs for a row but does not cancel an already accepted backend item. Stop the gateway and contain accepted items through an operator-reviewed backend procedure; never delete journal history or change dedupe keys to force a retry.

## Validation

Run `node --test google-apps-script/tests/*.test.cjs`. These tests execute the actual source against isolated in-memory Apps Script/Sheets/mail/HTTP substitutes; they do not send email or SMS. Baseline comparison covers email rendering, queue bytes, welcome tracking, household protection, Form upsert, Squarespace upsert/authentication, unsubscribe and preview. SMS tests cover AUTO/MANUAL, frozen retries, crash windows, lease fencing, phone/household fences, schedules/DST, GSM-7, all backend states, safe response validation and 401/404/409/5xx.

Local tests do not replace saved-source readback, actual Google OAuth/RAW Sheet writes, protection checks or controlled rollout validation. See `docs/validation/PHASE3B_STOPPED_VALIDATION.md` for the current evidence and open gates.

## Exact additive schema

### Templates

`L` SMS Revision; `M` SMS Status; `N` SMS Content Hash; `O` SMS Approved At; `P` SMS Approved By; `Q` SMS Required Variables.

### Campaigns

`AA` SMS Approval Mode; `AB` SMS Control; `AC` SMS Status; `AD` SMS Submitted Count; `AE` SMS Sent Count; `AF` SMS Failed Count; `AG` SMS Unknown Count; `AH` SMS Last Run At; `AI` Business Event Type; `AJ` Event Instance; `AK` SMS Policy Revision; `AL` SMS Policy Fingerprint.

### Master Leads

`V` SMS Opt Out; `W` SMS Opt Out At; `X` SMS Permission; `Y` SMS Permission Source; `Z` Welcome SMS Sent; `AA` Welcome SMS Sent At; `AB` Last SMS Campaign; `AC` Last SMS Sent At; `AD` Last SMS Status; `AE` Last SMS Queue ID; `AF` Business Lead ID; `AG` CRM First Seen At.

### Communication Log

`L` Event ID; `M` Event Type; `N` Event Instance; `O` Business Event Key; `P` Submission ID; `Q` Queue ID; `R` Scheduled At UTC; `S` Submitted At UTC; `T` Claimed At UTC; `U` Failed At UTC; `V` Observed At UTC; `W` Attempt Status; `X` Log Event Type.

### Campaign Preview

`M` SMS Outbox ID; `N` SMS Approval Mode; `O` SMS Control; `P` GSM-7 Septets; `Q` Scheduled At UTC; `R` SMS Validation; `S` Business Event Key; `T` SMS Revision.

### SMS Outbox

`A` Outbox ID; `B` Campaign ID; `C` Lead ID; `D` Business Lead ID; `E` Event ID; `F` Event Type; `G` Event Instance; `H` Business Event Key; `I` Phone; `J` Language; `K` Template ID; `L` SMS Revision; `M` Custom Message; `N` Variables JSON; `O` Preview; `P` GSM-7 Septets; `Q` Scheduled Time; `R` Approval Mode; `S` Send Control; `T` Eligibility; `U` Submission State; `V` Frozen Message; `W` Frozen ScheduledAt UTC; `X` Dedupe Key; `Y` Submission ID; `Z` Snapshot Hash; `AA` Queue ID; `AB` Backend Status; `AC` Attempt Status; `AD` Submission Error; `AE` Backend Error; `AF` Submitted At; `AG` Claimed At; `AH` Sent At; `AI` Failed At; `AJ` Last Checked At; `AK` Next Action At; `AL` HTTP Attempt Count; `AM` Authorization ID; `AN` Authorization Fingerprint; `AO` Status Sync; `AP` Created At; `AQ` Source; `AR` Source Record ID.

### SMS Submission Log

`A` Journal Event ID; `B` Recorded At UTC; `C` Journal Event Type; `D` Outbox ID; `E` Submission ID; `F` Snapshot Event ID; `G` Business Event Key; `H` Dedupe Key; `I` Authorization Mode; `J` Authorization ID; `K` Policy Revision; `L` Source Snapshot JSON; `M` Frozen Request JSON; `N` Snapshot Hash; `O` HTTP Attempt Number; `P` HTTP Status; `Q` Queue ID; `R` Submission State; `S` Backend Observation JSON; `T` Dispatch Lease Until; `U` Next Action At; `V` Safe Error.

### Settings (append rows in A:C)

`SMS_ENGINE_MODE` = `PREVIEW_ONLY`; `SMS_AUTO_ENABLED` = `FALSE`; `SMS_PAUSED` = `TRUE`; `SMS_ROLLOUT_MODE` = `ALLOWLIST`; `SMS_TEST_RECIPIENT_ALLOWLIST` = `(blank)`; `WELCOME_SMS_START_AT` = `(blank)`; `SMS_WELCOME_SOURCES` = `Google Form,Squarespace`; `SMS_TIMEZONE` = `America/Los_Angeles`; `SMS_MAX_NEW_PER_RUN` = `5`; `SMS_MAX_STATUS_PER_RUN` = `20`; `SMS_MAX_RUN_SECONDS` = `240`; `SMS_HTTP_RETRY_LIMIT` = `6`; `SMS_MAX_CAMPAIGN_LATENESS_MINUTES` = `240`; `SMS_MAX_WELCOME_AGE_DAYS` = `7`; `SMS_RULESET_VERSION` = `crm-sms-v1`.
