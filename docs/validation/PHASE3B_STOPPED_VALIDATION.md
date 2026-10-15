# Phase 3B validation status

Updated 2026-10-14. **Historical installation record; no further sends or merge authorized.**

Current results supersede pending items recorded chronologically below: saved-source
readback and one controlled CRM send passed. See [physical result](PHASE3B_FIRST_CRM_SMS_RESULT.md)
and [review](PHASE3B_REVIEW.md). Latest local suite: 77 passing. Performance changes
were saved and passed live preview and stopped batch-write checks (see review).
Complete independent workbook comparison remains unverified.

- Branch: reliability-phase-3b, based on main eae77d6 (Phase 3A PR #3 merge).
- Local source tests: 63 passing, zero failed. Uses isolated service substitutes; no external mail/SMS calls.
- Original five live editor files captured before edits; source hashes recorded under google-apps-script/tests/baseline/README.md. No lead export or Script Properties committed.
- User manually added SmsIntegration.gs and applied the four compatibility/preview patches. Screenshots checked incrementally. Full SmsIntegration.gs clipboard readback on 2026-10-14 matches the tested bundle except its generated comment and blank lines; complete compatibility-file readback remains pending. LeadIntake is intentionally unchanged.
- User-run paused installation and stopped runtime checks passed (evidence below). No SMS trigger or web-app deployment was installed during this stage. Full saved-source and independent workbook comparison remain pending.
- No Android behavior changed or gateway started by this implementation. No real SMS authorized or sent during local tests.
- Read-only Supabase inspection on 2026-10-14 confirmed enrollment-sheet-worker enabled=false, queue_count=1, attempt_count=1. Recheck after stopped runtime validation; counts alone do not replace evidence fingerprint comparison.

## Remaining gates

1. Complete saved compatibility-file readback and confirm LeadIntake unchanged against the captured baseline. The SMS bundle was compared before adding the diagnostic.
2. Independently compare preserved workbook prefixes and settings against baseline; user checks below establish the visible installed state, not a complete cell-by-cell comparison.
3. Verify unchanged Section B evidence fingerprints; aggregate backend counts alone are insufficient. Trigger screenshots cover the current owner, not all possible owners.
4. Keep PR unmerged and producer disabled. Credentials, test-recipient allowlist, AUTO activation and physical sending belong to a separate controlled rollout.

The captured baseline intentionally preserves original whitespace (including two git diff --check notices in WelcomeEmailImmediate_v3.gs); runtime source has normalized trailing whitespace.

## First live installer execution — blocked, 2026-10-14

User approved Google permissions. Execution began 10:18:27 AM Pacific and failed at
10:18:45 AM with SMS_SHEET_WRITE_FAILED in smsRaw_ -> smsPatch_ ->
smsSeedLeadsLocked_. Schema/settings and baseline properties may be partially applied;
do not treat this as a completed migration. Producer submissions are not part of this
installer. Added diagnoseSmsSheetAccess: reads only Master Leads A1 through the same
Sheets REST API, logging HTTP status and allowlisted Google reason codes only. No
secrets, raw responses, lead contents or write requests. The subsequent diagnostic identified a disabled Sheets API (resolved below). Local suite
now has 63 passing checks, including diagnostic data minimization.

## User-run stopped installation and smoke checks — 2026-10-14

Execution-log screenshots supplied by the user establish:

- 10:21:19 AM Pacific: Sheets REST diagnostic returned HTTP 403 with
  PERMISSION_DENIED / SERVICE_DISABLED. Google authorization had been approved.
- User added Google Sheets API v4 under Services. At 10:22:38 AM the diagnostic
  returned HTTP 200, reasons empty. For default Apps Script Cloud projects, adding
  the advanced service enables the corresponding API; standard Cloud projects need
  explicit API enablement. Include this prerequisite before installation.
- installSmsCrmPaused ran 10:23:04–10:24:49 AM and completed without an error.
- validateStoppedSmsIntegration ran 10:32:27–10:32:38 AM and logged:

```json
{"schema":"crm-sms-v1","mode":"PREVIEW_ONLY","paused":true,"auto":false,"outbox":0,"producerCalls":0,"unauthorized":{"queue-enrollment-sms":401,"sms-queue-status":401},"smsTrigger":false}
```

The validator also checks an empty Submission Log and both existing SMS switches
false before logging success. Its trigger enumeration covers triggers visible to
its executing user, not necessarily all other owners' triggers. The two unauthorized
HTTP requests are intentional; producerCalls=0 means no authenticated submission.
These results supersede the earlier installer/runtime-pending entries. Remaining:
complete compatibility-file readback, independent workbook prefix/protection checks,
existing email/intake diagnostics and all-owner trigger inventory. Do not merge or
enable AUTO based on this stopped check alone.

## Additional stopped checks — 2026-10-14

User execution-log screenshots establish:

- 14:11:13 Pacific: email validation completed in PREVIEW_ONLY, campaignsEnabled=FALSE,
  welcomeEnabled=FALSE, testInboxConfigured=true, unsubscribeURLConfigured=true,
  postalAddressConfigured=false, contactBasisConfirmed empty, queuedRows=6, logRows=7.
  This is configuration validation, not proof of email delivery or complete regression coverage.
- 14:12:07 Pacific: Squarespace welcome check completed with webhook=TRUE,
  engineMode=PREVIEW_ONLY, welcomeEnabled=FALSE, squarespaceWelcome=FALSE,
  welcomeCampaignEnabled=No, welcomeTemplate=Approved, activationDate unset,
  testInboxConfigured=true, sentByValidation=0. No intake request was submitted.
- 14:13:09 Pacific trigger screenshot shows runDueEmailCampaigns (time-based)
  and handleOriginalFormSubmit (spreadsheet form-submit), with no SMS trigger shown.

User subsequently confirmed both SMS tabs contain headers only, the SMS menu exists,
paused settings match, sampled Master Leads rows have Unknown permission and populated
Business Lead ID/First Seen fields, and the Submission Log protection is restricted.
These are user-reported workbook checks, not an independent complete workbook diff.

A subsequent read-only backend check returned producer_enabled=false, queue_count=1,
attempt_count=1. No new queue rows or attempts are indicated by these aggregate counts.
No gateway session was started or sending authorized during these checks.

## Focused stopped preview — 2026-10-14

Full CampaignEngine readback differed only in formatting and equivalent single-statement
blocks. User-pasted EmailAutomation, WelcomeEmailImmediate_v3 and SquarespaceWebHook
matched tested logic; LeadIntake matched the baseline byte for byte. Pasted SMS runtime
matched except for the omitted optional Sheets-access diagnostic and generated comment.
User confirmed the project saved. Later temporary diagnostic helpers were added manually.

User screenshots: authenticated empty-object probes returned 400 for both endpoints at
15:19:58 Pacific after earlier fetch-permission exceptions. Unauthenticated fetch returned
401 at 15:19:27. The stopped validator passed again at 15:20:41: PREVIEW_ONLY, paused=true,
auto=false, outbox=0, producerCalls=0, both unauthorized probes=401, smsTrigger=false.
These probes did not create queue items; this is not an authorized ingest/send test.

User canceled the broad campaign preview after prolonged execution. Repeated per-lead
smsContext_ reads are a likely performance cause; no timing profile was captured. The
broad preview has not been fixed or validated for production-sized lead lists.
Added smsInspectLeadStopped_ for a single identified lead: one context read, no writes,
no HTTP, no approvals, no frozen request, explicit schedule issues and broad-audience
counts. Two new tests verify no mutation/HTTP and stopped-mode/identity guards; all 65
local tests pass. Live focused-check result remains pending. Preparation is not send
approval; producer and gateway must remain stopped.

## Focused live preview and allowlist planning fix

User screenshots on October 14 show the focused preview completing in 4–7 seconds.
After correcting the test lead language, the rendered message is 62 GSM-7 septets,
one segment, AUTO; business identity matches and the allowlist contains only the
test recipient. Schedule resolves to 2026-10-15T00:00:00.000Z (October 14, 17:00
Los Angeles). Following user policy approval, POLICY_CHANGED disappeared; only
CAMPAIGN_NOT_ARMED remains with Enabled=No. Zero submissions are reported. Audience
counts: 28 total, 27 outside allowlist. The snapshot is not a frozen send request.

Planner now filters out non-allowlisted recipients before scheduled snapshot and
outbox creation. Four new isolated tests cover welcome exclusion, frozen scheduled
audience/allowlist expansion, empty/malformed lists and invalid mode, and unchanged
production behavior. All 69 tests pass. Replacement smsPlanLocked_ supplied for
manual installation; live installed-code verification remains pending. No gateway,
producer enablement, or SMS send authorized by this preparation.
