# Phase 3B validation status

Updated 2026-10-14. **Not approved for merge or sending.**

- Branch: reliability-phase-3b, based on main eae77d6 (Phase 3A PR #3 merge).
- Local source tests: 62 passing, zero failed. Uses isolated service substitutes; no external mail/SMS calls.
- Original five live editor files captured before edits; source hashes recorded under google-apps-script/tests/baseline/README.md. No lead export or Script Properties committed.
- User manually added SmsIntegration.gs and applied the four compatibility/preview patches. Screenshots checked incrementally. Full SmsIntegration.gs clipboard readback on 2026-10-14 matches the tested bundle except its generated comment and blank lines; complete compatibility-file readback remains pending. LeadIntake is intentionally unchanged.
- No paused installer, workbook migration, SMS trigger installation, real Apps Script runtime smoke test or web-app deployment has been verified yet.
- No Android behavior changed or gateway started by this implementation. No real SMS authorized or sent during local tests.
- Read-only Supabase inspection on 2026-10-14 confirmed enrollment-sheet-worker enabled=false, queue_count=1, attempt_count=1. Recheck after stopped runtime validation; counts alone do not replace evidence fingerprint comparison.

## Remaining gates

1. Read back all six saved editor files; compare semantics with tested source, including exact generated SMS bundle.
2. Run installSmsCrmPaused with the designated operator; verify only two new tabs and all original prefixes, values, formulas, validation and email/intake settings preserved.
3. Verify Google authorization and RAW-write readback, protected journal, recorded first-seen baseline and Unknown default permission. Do not enable producer.
4. Run validateStoppedSmsIntegration: both unauthenticated endpoints 401, SMS tabs empty, paused/preview-only/AUTO false, no SMS trigger. Verify pre-existing triggers unchanged.
5. Recheck backend disabled binding and unchanged real Section B evidence. Record deployed/editor hashes and runtime output without secrets or contact data.
6. Keep PR unmerged until these stopped CRM gates pass. Controlled AUTO/physical send rollout is separate authorization.

The captured baseline intentionally preserves original whitespace (including two git diff --check notices in WelcomeEmailImmediate_v3.gs); runtime source has normalized trailing whitespace.

## First live installer execution — blocked, 2026-10-14

User approved Google permissions. Execution began 10:18:27 AM Pacific and failed at
10:18:45 AM with SMS_SHEET_WRITE_FAILED in smsRaw_ -> smsPatch_ ->
smsSeedLeadsLocked_. Schema/settings and baseline properties may be partially applied;
do not treat this as a completed migration. Producer submissions are not part of this
installer. Added diagnoseSmsSheetAccess: reads only Master Leads A1 through the same
Sheets REST API, logging HTTP status and allowlisted Google reason codes only. No
secrets, raw responses, lead contents or write requests. Diagnosis pending. Local suite
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
