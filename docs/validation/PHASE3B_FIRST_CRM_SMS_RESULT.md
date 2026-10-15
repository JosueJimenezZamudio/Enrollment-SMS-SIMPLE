# First controlled CRM SMS — 2026-10-14

One explicitly authorized CRM test completed end to end. The user confirmed one
message received and subsequently confirmed the Sheet Backend Status changed to
`sent` after status refresh. This is not authorization for additional sends or merge.

## Correlated evidence

- Queue: `05d3d397-6395-48ca-9134-09a84e9d54c9`
- Attempt: `a532081e-4d90-4874-b0a7-bf503f9012a7`
- Outcome event: `3e10e260-264a-4ed4-8439-cc228713df17`
- Scheduled: `2026-10-15T00:20:00Z`
- Created: `2026-10-15T00:21:28.131515Z`
- Send authorized: `2026-10-15T00:27:07.807554Z`
- Completed: `2026-10-15T00:27:08.8475Z`

Backend query verified `sent`, exactly one attempt and one send-log row for this
queue. The physical handset journal was ACKNOWLEDGED, with matching queue,
attempt, outcome and completion values; no pending outcomes or active requests
remained. The approved template rendered to 62 GSM-7 septets, one segment.
The Sheet first showed ACCEPTED/queued, then the user confirmed sent.

The manually invoked worker completed normally after slow Sheet writeback.
No recurring SMS worker trigger was installed. Local Apps Script tests previously
passed 69 checks, including filtering the allowlist before planning draft rows.

## Containment

The user stopped the gateway and set SMS_PAUSED TRUE. The gateway was independently
verified stopped; SEND_SMS permission was revoked after journal verification.
After the final Sheet refresh, enrollment-sheet-worker was disabled and independently
queried as enabled=false; the queue remained sent with one attempt and one log.

The user explicitly chose to retain the Sheet settings: LIVE, AUTO TRUE, campaign
SMS TRUE and test campaign Enabled Yes, with SMS_PAUSED TRUE. Producer remains
disabled and gateway stopped with SMS permission revoked. Do not treat retained
settings as authorization to resume. Preserve the allowlist and all journal history.

Broader rollout, recurring operation, live retry/fault scenarios and PR merge remain
outside this test. No additional SMS is authorized.
