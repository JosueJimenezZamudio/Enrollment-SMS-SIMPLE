# SMS English default validation

October 14, 2026, America/Los_Angeles.

The user installed CampaignEngine.gs and the rebuilt SmsIntegration.gs, then ran
`tools/ValidateSmsLanguageNoSend.gs` in the live Apps Script project and supplied:

```json
{"result":"PASS","fingerprint":"c213ea0d78555e70f7fe017abe7403e255352953c417b0a88b0b04f2fb95311d","functionsChecked":98,"checks":["blank:EN","undefined:EN","unrecognized:EN","English:EN","Spanish:ES","ES:ES","accented alias:ES","alias:ES"],"frozenSnapshot":"PASS","smsSubmitted":0,"crmWrites":0}
```

The fingerprint covers the function source strings of all 98 declared functions
and all five top-level constants in the two installed files. This establishes
executable-source/constant agreement with the tested version, not byte equality
of file comments or whitespace outside functions. CRLF is normalized to LF.

The live synthetic check exercises the shared resolver, rendering, AUTO eligibility,
preview issue evaluation, freezing, and snapshot recovery after input changes.
It never calls the producer, reads/writes CRM rows, or modifies settings/triggers.
The full preview-to-outbox-to-HTTP and frozen retry flows are additionally covered
by the isolated local regression suite: 89 tests passing. No physical SMS was
sent for this validation; no live producer, gateway or automation setting changed.

No merge blockers were found in the language diff. Explicit Spanish aliases remain
Spanish; other preferences resolve to English for SMS only. Email behavior and
frozen retry bytes remain unchanged. The validator may remain as an optional
manually invoked diagnostic; do not install a trigger for it.
