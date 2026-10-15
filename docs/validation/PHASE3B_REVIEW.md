# Phase 3B focused review — 2026-10-14

Scope: slow preview/worker paths, duplicate prevention, recipient restrictions,
compatibility changes and controlled-send evidence. No production writes or sends
were performed during this review. PR #4 remains draft and unmerged.

## Findings addressed

1. Campaign preview loaded five CRM tables twice per SMS recipient. With the
   observed 28-recipient audience, that was 56 full SMS context loads. The preview
   now passes one invocation-local context to both helpers. A 28-lead regression
   verifies one context load, 56 Both-channel preview rows, zero API/mail calls,
   and fresh suppression on the next invocation. No global authorization cache.
2. Sparse row patches made separate RAW HTTP writes and readbacks per contiguous
   changed range. They now use one values:batchUpdate request plus one readback,
   preserving intervening cells, literal text and verification of all changed
   values. Journal appends remain individually verified before producer POST.
   Tests cover unchanged values, untouched email fields, failed writes and a 200
   response without persisted values; neither failure permits a producer request.

These are evidenced sources of excess I/O, not a measured explanation of every
second in the observed worker run. Remaining repeated table reads/projection work
may still be expensive for large histories. No live latency improvement is claimed.

## Duplicate and recipient review

Existing tests verify stable semantic keys, immutable request bytes, response-loss
recovery, active dispatch leases, deleted Outbox recovery and no re-POST after
ACCEPTED. The journal is retained for unknown outcomes. The allowlist filters
scheduled audience freezing and draft creation, and is checked again at dispatch.
Five new tests change allowlist, permission, opt-out, phone or pause after an
uncertain request, confirming no second POST and unchanged frozen bytes.

77 local source tests pass. The generated bundle was rebuilt. LeadIntake remains
byte-identical to its baseline and email/intake compatibility regressions pass.
GitHub reported no checks/statuses on the previously published a0bed52 revision;
local tests are the evidence here, not a claimed CI pass.

## Installation and limits

The controlled physical send used the preceding 69-test bundle; its result is in
PHASE3B_FIRST_CRM_SMS_RESULT.md. The review revision is not installed in the saved
Apps Script project. Replace SmsIntegration.gs with the generated bundle and update
CampaignEngine.gs together, keeping the producer disabled and SMS_PAUSED TRUE.
Do not rerun the migration or the initial empty-tabs validator on populated logs.
Use a non-sending campaign preview to check the new preview path; a stopped,
operator-controlled Sheet patch/readback check is still needed for the batch API.

The user elected to leave LIVE/AUTO/campaign settings in place behind SMS_PAUSED
TRUE and the disabled server producer. Gateway remains stopped with SEND_SMS
revoked. No recurring trigger or broader rollout is approved. Physical failure
injection and independent whole-workbook comparison remain outside this review.
