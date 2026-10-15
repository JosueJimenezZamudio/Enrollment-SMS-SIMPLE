> Implementation refinement: the user requested a strict SMS boundary. The worker now reconciles Master Leads without intake hooks; LeadIntake is unchanged and Squarespace keeps its original return contract. See PHASE3B_IMPLEMENTATION.md for the authoritative implementation and stopped rollout status. The architecture below records the preceding design.

# Phase 3B: integrate SMS into the existing Ednovate CRM

Revised 2026-10-13. Design only. Supersedes the separate-workbook, manual-only
proposal in PHASE3B_SHEET_APPS_SCRIPT_DESIGN.md. AUTO is part of Phase 3B and is
the planned rollout mode. No source code, live Sheet, trigger, secret, producer
binding or Android state was modified during this inspection.

## Grounded sources and findings

Live workbook: Ednovate Enrollment Lead CRM (Main),
https://docs.google.com/spreadsheets/d/1KUmlLfCJIkrmui-FHDn3mnbqEJ0n2yp-QJwU-Ja-8x4/edit
Timezone America/Los_Angeles. The older similarly named workbook lacks the current
Events/Templates/Preview/Email Queue structure and is not the integration target.

Inspected bounded live ranges: Master Leads A1:AA1; Campaigns A1:Z12;
Events A1:L12; Templates A1:K16; Settings A1:C60; Communication Log A1:O1;
Campaign Preview A1:L1; Email Queue A1:O1; SchoolMint Data A1:O1.
Observed tab IDs respectively: 2067173533, 1001, 3001, 3002, 1004, 1002,
3003, 3004, 1003; hidden Raw Form Leads is 1005.

Live Apps Script editor inspected, not executed:
https://script.google.com/u/0/home/projects/1TY07ICAG_MMK4U7-JrtBF17kPQ5iuuwbSqJganQFKuTFTpabO7lODikK/edit
Files: LeadIntake.gs, CampaignEngine.gs, EmailAutomation.gs,
WelcomeEmailImmediate_v3.gs, SquarespaceWebHook.gs. Read via editor and temporary
unsaved TextEdit copies. Downloaded setup packages were located but not treated as
the authority over current editor source. Web-app deployment version was not compared
to editor head; implementation must capture that version before changing a deployment.

Observed triggers: runDueEmailCampaigns (time-based) and handleOriginalFormSubmit
(spreadsheet form submit), both displayed as owned by Other user. The installer code
specifies a ten-minute email interval. Do not recreate or remove these triggers.
Deployment must use the intended existing automation owner for the new SMS trigger.

Actual logic that determines this design:

- Templates already has SMS Body EN/ES in H:I. Campaigns has SMS EN/ES overrides
  in S:T, plus Channel Email/SMS/Both and Message Mode Template/Custom/Template + Override.
  Inspected template SMS bodies are empty: current email approval does not supply
  SMS content. No welcome SMS can render until those cells are populated/approved.
- CampaignEngine already resolves lead language, event joins and twelve single-brace
  variables. It previews both channels but unconditionally flags SMS transport missing.
  It also renders the blank SMS subject through a validator that rejects empty content;
  SMS preview must validate the body only. Preview is not an approval or send queue.
- EmailAutomation actually accepts Email-only campaigns in several guards, despite
  Both being supported by preview. Changing the Channel cell alone to Both would
  currently prevent email delivery. All production email paths need the same minimal
  channel-membership compatibility change for integrated Both campaigns.
- Email scheduled dedupe is D- plus a base64url SHA-256 of Campaign ID, a separator
  and normalized email. Do not replace historical email keys with the SMS algorithm.
- Scheduled email snapshots its audience once; four-hour lateness limits apply.
  Welcome is special-cased to WELCOME-EMAIL, has an activation cutoff, household
  email dedupe and no historical backfill. Keep that ID even when enabling SMS on
  the same campaign; an ID rename would invalidate those established assumptions.
- Form intake generates stable source fingerprints then persistent LEAD- UUIDs.
  Squarespace upserts by email and fills missing contact fields; created, updated
  and already_exists are distinct. Both have immediate welcome email paths as well
  as background recovery. SMS capture must be independent of email send success.
- Email summary writes Campaigns V:Y and completes V. Email tracking writes Master
  Leads M:P after queue/log corroboration. SMS must not overwrite these ranges.
- Communication Log A:K already includes Channel and Delivery Key; email corroboration
  filters Channel=Email. Reuse this log, with SMS-specific detail appended at the right.
- Settings currently shows PREVIEW_ONLY and both email/SMS welcome/campaign switches
  FALSE. Squarespace webhook is TRUE but its welcome-import email switch is FALSE.
  Some comments/descriptions are older than the installed code; source and observed
  switch values, not comments claiming no transport exists, ground this design.

## Architecture

One CRM workbook and its existing bound Apps Script project. Add SMS modules there,
not a second workbook or independent recipient/campaign system. New source modules
would separate policy/planning, immutable journal, API transport and projection.
Reuse existing pure campaign language/message/merge helpers where correct; add a
channel-specific validation wrapper instead of changing email rendering semantics.

Flow: existing Form/Zapier intake -> Master Leads -> campaign/event planner ->
AUTO eligibility or MANUAL approval -> SMS Outbox + immutable SMS Submission Log ->
deployed producer ingest -> Android -> scoped status reads -> Outbox + shared
Communication Log + SMS-only lead/campaign summaries.

Script Properties in this project hold SMS_API_BASE_URL, SMS_INGEST_SECRET,
SMS_STATUS_SECRET and SMS_EXPECTED_CRM_ID. No secret in cells, logs or URLs. Never
store a Supabase service-role key or Android device token. Script editors have access
to project properties, so existing project-editor access is the trust boundary.
No new public doPost: retain the current authenticated Squarespace/unsubscribe router.

## Exact existing-tab changes

All additions append after populated columns; do not insert into existing prefixes.
Several readers assert positional headers, so preserve existing names/order. Fresh
readback is required before implementation because these are live documents.

### Templates — preserve A:K; append L:Q

L SMS Revision; M SMS Status; N SMS Content Hash; O SMS Approved At;
P SMS Approved By; Q SMS Required Variables.

Reuse A Template ID, H SMS Body EN, I SMS Body ES. Keep Template ID unique: existing
validation rejects duplicate IDs, so do NOT append multiple rows with the same ID
for versioning. Increment SMS Revision on the existing row and retain prior versions
as immutable snapshots in SMS Submission Log. SMS Status is Draft/Approved/Hold,
separate from J Status so approving an email cannot implicitly approve new SMS text.
AUTO requires J=Approved, M=Approved and a matching content hash. Editing H:I or
required-variable rules invalidates SMS approval without changing email approval.
An intentional new template can of course use a genuinely new Template ID.

### Campaigns — preserve A:Z; append AA:AL

AA SMS Approval Mode (AUTO/MANUAL)
AB SMS Control (DRAFT/READY/HOLD)
AC SMS Status (planning/projection only)
AD SMS Submitted Count
AE SMS Sent Count
AF SMS Failed Count
AG SMS Unknown Count
AH SMS Last Run At
AI Business Event Type
AJ Event Instance
AK SMS Policy Revision
AL SMS Policy Fingerprint

Reuse Campaign ID, Trigger, Send Date/Time, Channel, Audience, Message Mode,
Template ID, Event ID and existing SMS overrides. U Enabled remains the shared
campaign kill switch. V Status and W:Y remain the legacy email status/counters;
AB/AC independently control/report SMS. Email marking V Complete does not stop
an already armed SMS campaign. SMS never marks V Complete. For SMS-only campaigns,
AC is the authoritative completion display; V remains unchanged.

One shared campaign can use Channel=Both after the narrow email compatibility
updates described below. WELCOME-EMAIL remains the same record and identity.
AI is New Lead for welcome, the Events Event Type for event-backed campaigns,
or Campaign for an explicitly non-event campaign. AJ is a fixed occurrence identity:
welcome:onboarding:v1 for welcome; the existing Event ID for an event campaign;
the immutable Campaign ID for a one-shot non-event campaign. A second reminder is a
separate business campaign/occurrence, not a retry-generated revision or timestamp.

AUTO uses approved Template mode only. Custom or an effective SMS override requires
MANUAL, even if the campaign requests AUTO. Policy fingerprint covers template SMS
revision/hash, audience, trigger/schedule, identity, SMS mode and relevant channel
configuration. Editing policy inputs invalidates the campaign's READY policy until
re-armed; it cannot silently change a running campaign. Newly arriving lead values
are deliberately allowed inputs to an already armed AUTO policy.

### Settings — reuse A:C key/value/description layout

Reuse WELCOME_SMS_ENABLED and CAMPAIGN_SMS_ENABLED. Add these keys:

| Key | Installation / intended controlled AUTO rollout |
|---|---|
| SMS_ENGINE_MODE | PREVIEW_ONLY / LIVE |
| SMS_AUTO_ENABLED | FALSE / TRUE |
| SMS_PAUSED | TRUE / FALSE |
| SMS_ROLLOUT_MODE | ALLOWLIST / ALLOWLIST initially |
| SMS_TEST_RECIPIENT_ALLOWLIST | Empty / designated permitted test handset numbers |
| WELCOME_SMS_START_AT | Empty / one fixed UTC activation cutoff |
| SMS_WELCOME_SOURCES | Google Form,Squarespace |
| SMS_TIMEZONE | America/Los_Angeles |
| SMS_MAX_NEW_PER_RUN | 5 |
| SMS_MAX_STATUS_PER_RUN | 20 |
| SMS_MAX_RUN_SECONDS | 240 |
| SMS_HTTP_RETRY_LIMIT | 6 |
| SMS_MAX_CAMPAIGN_LATENESS_MINUTES | 240 |
| SMS_MAX_WELCOME_AGE_DAYS | 7 |
| SMS_RULESET_VERSION | crm-sms-v1 |

SMS mode is independent of CAMPAIGN_ENGINE_MODE. Do not set the latter to LIVE
just to test SMS or toggle email switches. Do not repurpose
SQUARESPACE_WELCOME_ON_IMPORT, which the actual code uses for email. Use the SMS
source allowlist plus the SMS welcome switch for that source's SMS eligibility.
All keys unique. Operational settings/policy fields restricted to authorized operators.
ALLOWLIST restricts eligibility; never redirect a family's payload to a test phone.

### Master Leads — preserve A:U; append V:AG

V SMS Opt Out; W SMS Opt Out At; X SMS Permission; Y SMS Permission Source;
Z Welcome SMS Sent; AA Welcome SMS Sent At; AB Last SMS Campaign;
AC Last SMS Sent At; AD Last SMS Status; AE Last SMS Queue ID;
AF Business Lead ID; AG CRM First Seen At.

Use existing A Lead ID, F Phone, H Preferred Language, I Source, J Source Record ID,
K/L application state and Q Active Lead. No duplicated contacts table. SMS Permission
is Allowed/Unknown/Denied, derived from an explicit recorded source; do not infer it
from email permission. Unknown/Denied and opt-out suppress AUTO and MANUAL alike.
No inbound STOP capability is implied; this phase adds outbound suppression fields.
Email opt-out remains email-specific and is not silently rewritten or treated as
proof of SMS permission. Apply SMS suppression across matching normalized phone records.

Business Lead ID is a persisted canonical CRM lead reference, using the existing
oldest-active household/email selection where applicable. Duplicate or ambiguous
household/phone mappings block AUTO rather than choosing a new recipient. Preserve
the mapping across later inactive status changes; never rotate dedupe identity when
an older lead becomes inactive. Phone-only leads use their persistent CRM Lead ID.
CRM First Seen At is an ingestion observation, not the caller's supplied timestamp.
Seed existing rows as baseline history at cutover and exclude them from welcome;
new rows get first-seen recorded by intake/recovery. Do not welcome historical
imports merely because they were loaded after activation.

Do not write M:N Welcome Email fields or O:P legacy email contact fields from SMS.
Write SMS sent flags only after authoritative backend sent observation and recorded
Communication Log evidence, never on acceptance/HTTP success.

### Communication Log — preserve A:K; append L:X

L Event ID; M Event Type; N Event Instance; O Business Event Key;
P Submission ID; Q Queue ID; R Scheduled At UTC; S Submitted At UTC;
T Claimed At UTC; U Failed At UTC; V Observed At UTC; W Attempt Status;
X Log Event Type.

Reuse Channel=SMS, Recipient, Status, Error and Delivery Key. Delivery Key is the
SMS dedupe key; Queue ID has its own Q column; J Message ID stays blank because
the producer API exposes no carrier message ID. G Sent At is populated only for
backend sent, using its timestamp. Append one deterministic Log ID per material
observation, not per unchanged poll. Dedupe projection writes after crashes.
Count distinct Queue IDs, never log rows, in campaign summaries. Old email rows
and their exact Delivery Keys remain unchanged; appended fields may be blank.

### Campaign Preview — preserve A:L; append M:T

M SMS Outbox ID; N SMS Approval Mode; O SMS Control; P GSM-7 Septets;
Q Scheduled At UTC; R SMS Validation; S Business Event Key; T SMS Revision.

Reuse existing channel/language/message preview. Fix SMS-only empty-subject validation
and replace the unconditional transport warning with real SMS readiness checks.
Refreshing preview remains read-only with respect to sending/approval. The old
preview writer clears only A:L: revised preview code must clear/rebuild the full
owned A:T preview range to avoid stale SMS columns. This tab is disposable display,
never the authoritative approval/snapshot ledger.

### Events, Email Queue, SchoolMint Data, Raw Form Leads

No new columns required. Reuse Events A:L as the event authority. Send Date/Time
is from Campaigns, not implicitly from event start time. Event Time Zone governs
event display; SMS_TIMEZONE governs campaign scheduling. Blank SchoolMint application
state remains unknown, not Not Applied. Leave source sheets/import contracts alone.
Email Queue remains a separate channel transport queue and keeps all legacy keys.

## New tabs — exactly two

### SMS Outbox: exact A:AR columns

| Range | Ordered headers |
|---|---|
| A:F | Outbox ID; Campaign ID; Lead ID; Business Lead ID; Event ID; Event Type |
| G:L | Event Instance; Business Event Key; Phone; Language; Template ID; SMS Revision |
| M:R | Custom Message; Variables JSON; Preview; GSM-7 Septets; Scheduled Time; Approval Mode |
| S:X | Send Control; Eligibility; Submission State; Frozen Message; Frozen ScheduledAt UTC; Dedupe Key |
| Y:AD | Submission ID; Snapshot Hash; Queue ID; Backend Status; Attempt Status; Submission Error |
| AE:AJ | Backend Error; Submitted At; Claimed At; Sent At; Failed At; Last Checked At |
| AK:AR | Next Action At; HTTP Attempt Count; Authorization ID; Authorization Fingerprint; Status Sync; Created At; Source; Source Record ID |

Most columns are system projections. Operators create manual rows through a menu
using a real CRM lead; a new person is added to Master Leads first. Manual inputs
are custom message/template selection, schedule and appropriate event/campaign
context. Variables JSON is a captured system view of the CRM merge values, not a
second hand-maintained set of lead data. IDs, phones, payload JSON and results are
stored literally/RAW to avoid formula execution.

### SMS Submission Log: exact A:V columns

A Journal Event ID; B Recorded At UTC; C Journal Event Type; D Outbox ID;
E Submission ID; F Snapshot Event ID; G Business Event Key; H Dedupe Key;
I Authorization Mode; J Authorization ID; K Policy Revision;
L Source Snapshot JSON; M Frozen Request JSON; N Snapshot Hash;
O HTTP Attempt Number; P HTTP Status; Q Queue ID; R Submission State;
S Backend Observation JSON; T Dispatch Lease Until; U Next Action At; V Safe Error.

Append-only operational ledger. PREPARED contains the exact six-field HTTP JSON,
all normalized payload fields, policy/template/language/variable provenance and
authorization. New events record dispatch, receipts, retries, HOLD, status and
projection completion. Existing records never change. Use deterministic event IDs
and read-back verification to recover ambiguous Sheet writes. No HTTP without a
verified frozen record and dispatch reservation. Protect from routine editing;
Sheets is not tamper-proof WORM storage against owners. Backend receipts remain
the final authority. Communication Log is the CRM-facing history; this log is the
SMS-specific durability/recovery protocol, so both have distinct purposes.

## AUTO and MANUAL in Phase 3B

AUTO: enabled/armed campaign policy + SMS switch + LIVE + AUTO enabled + not paused
+ matching audience + active lead + allowed source/permission + no suppression
+ confirmed event if used + approved SMS template + supported language + valid
US phone + nonempty GSM-7 <=160 septets + valid schedule + no prior logical send.
The planner creates a READY row and records AUTO policy authorization, then freezes
and submits without any per-row preview/approval click. Invalid rows visibly block.
Blank/unknown language requires correction rather than silently using English for AUTO.

MANUAL: one-off/custom/override -> DRAFT -> explicit preview -> explicit approval
of exact recipient/text/schedule -> READY -> the same freeze/transport path. Any
effective custom override forces MANUAL; changing the mode cell cannot bypass it.
Revalidate the preview fingerprint before freezing. Changing a prepared draft never
mutates its snapshot; uncertain or accepted work requires reconciliation first.

HOLD blocks new POSTs, including retries; status reads continue. It cannot recall
an already in-flight POST or accepted SMS. Existing backend has no cancellation RPC.
The worker rechecks switches/suppression immediately before first ingest; a later
opt-out after backend acceptance cannot be guaranteed to recall that message.

There is no onEdit network send. Under an already armed AUTO campaign, newly valid
CRM data can intentionally produce a send on the next worker run. Thus the old
unqualified promise that edits can never lead to sends is replaced by explicit
policy-based automation; arbitrary drafts and unarmed campaign edits still never send.

Submission states: DRAFT -> ELIGIBLE (AUTO) or APPROVED (MANUAL) -> PREPARED ->
SUBMITTING -> ACCEPTED. Validation failures -> BLOCKED; uncertain HTTP ->
RETRY_PENDING; 409 -> CONFLICT; 401 -> AUTH_ERROR; exhausted/unexplained failures ->
REVIEW_REQUIRED. No submission state means physical delivery.
Backend status remains separate: queued/claimed/sending/unknown/sent/failed/cancelled.
Unknown and failed never generate a new queue item automatically.

## Common identity, frozen payload and schedule

Business tuple: ["crm-event-v1", CRM.ID, Business Lead ID, Campaign ID,
Business Event Type, Event Instance]. Business Event Key is a prefixed SHA-256 of
canonical JSON tuple. SMS dedupe key derives from that key plus the literal SMS
channel, never current time, row number, mutable message, phone, schedule or language.
Event time changing must not produce a new key. A genuine second outreach is an
explicit new campaign/business occurrence, not a “retry with a new key.”

Email and SMS refer to the same existing lead/campaign/event identity. Do not rewrite
email Delivery Keys: correlate existing email records through Campaign ID + Lead ID
and the preserved campaign event mapping. New channel metadata may be appended to
email log rows without changing their send or dedupe behavior. SMS additionally
enforces a persistent same-phone/same-occurrence fence in the journal, so duplicate
CRM records cannot produce separate AUTO sends to the same handset. Conflicting
shared-phone personalized content requires review rather than selecting arbitrarily.

Each campaign occurrence freezes its selected audience once, like scheduled email.
The shared planner stores/verifies an audience snapshot event before generating SMS
rows. Recover unfinished generation from that snapshot; do not add later leads to
an already planned scheduled campaign. Welcome is a continuous stream of new business
leads after its fixed activation cutoff; baseline leads remain excluded. Persist
ineligibility reasons and age-limit catch-up rather than repeatedly creating drafts.

API JSON contains exactly phone, message, leadId, eventType, dedupeKey, scheduledAt.
leadId is the retained CRM representative lead ID; provenance records source IDs too.
Normalize phone and trim rendered text before freezing. Store one JSON string/hash
and send it verbatim every time. SMS-required variables use the existing single-brace
renderer: ParentName, StudentName, Email, Grade, CampaignName, EventName, EventDate,
EventTime, EventEndTime, EventLocation, EventAddress, RSVPLink. Do not introduce a
parallel double-brace language. Literal one-off custom text need not interpolate;
campaign Custom/Override uses the existing renderer and requires manual approval.

Scheduled campaigns freeze the configured local Send Date/Time converted once to
UTC, with explicit DST validation. Welcome/unscheduled manual rows freeze the
preparation instant once. Persist ISO UTC with milliseconds; never recalculate on
retry. Schedule is not an exact delivery appointment. Preserve 160 GSM-7 septets,
including extension characters counting twice; Spanish text must pass that same
actual character test. Never silently transliterate or hardcode a fallback body.

## Existing-script integration changes, later implementation only

- LeadIntake / SquarespaceWebHook: after durable creation, call the common SMS
  capture helper independently of email result. Return persisted Lead ID from the
  Squarespace upsert, not only row position. Existing email routines are preserved.
  Do not call send while holding the intake lock. Timer reconciliation catches a
  crash after lead write and before SMS capture, using first-seen/baseline/source
  guards, and the same immutable identity. Webhook updates/replays do not re-welcome.
- CampaignEngine: reuse pure helpers; add SMS validation, policy/preview menu
  actions and append-only-column readers. Do not globally extend old arrays in a
  way that changes the widths of legacy setValues calls. Keep preview non-sending.
- EmailAutomation / both immediate welcome paths: replace strict Email equality
  checks with common channel membership where Both needs email. Preserve email
  keys, sender, quotas, source switches, unsubscribe logic, retry behavior and
  special WELCOME-EMAIL ID. Keep email summaries confined to legacy fields.
- SMS worker: same Apps Script project for shared ScriptLock and shared log writes.
  One owner-installed minute timer, bounded ingest/poll batches. No new form trigger,
  duplicate webhook route or separate SMS contact store. Existing triggers untouched.
  A ten-minute dispatch lease and immutable dispatch event coordinate overlapping
  runs; HTTP runs outside short locks. Acquire the same lock for all shared log
  getLastRow+append operations so email and SMS cannot overwrite each other.
- Maintain separate SMS mode/switches. Shared Campaigns Enabled can stop both
  channels; individual channel switches/control stop only their own new ingestion.
  Project/web-app update uses the current deployment ID and owner after validating
  unsubscribe and authenticated intake regression tests; no new deployment now.

## API reconciliation and writeback

Use deployed queue-enrollment-sms and sms-queue-status with different secrets in
the x-enrollment-sms-secret header. 201 creates, 200 returns identical existing
receipt, 409 blocks mismatched payload. Timeout/429/transient5xx use capped backoff
1/2/5/15/30/60 minutes, same body and key; exhausted attempts require review.
Known disabled/configuration errors pause rather than retry flooding. Journal
conflicts/missing snapshots stop ingestion, never reconstruct from mutable cells.

Status endpoint is single-item, no batch scan. Query queueId+dedupeKey when known,
dedupeKey otherwise. Validate returned identity and schedule. Only nine queue fields
are available: id, dedupe_key, status, scheduled_at, claimed_at, sent_at, failed_at,
last_error, attempt_status. It has no payload hash, message, attempt ID, local ACK
or carrier delivery receipt. A status hit after uncertain ingestion is only a
candidate: exact frozen ingest replay confirms payload equivalence before ACCEPTED.
404 can mean disabled/unowned/nonexistent; never treat it as permission for a new key.

Poll queued/claimed/sending fairly within twenty reads/run, unknown less frequently;
stop routine terminal polling once logged. Status-only work continues during local
pause/HOLD. Preserve last state and show staleness after read failures. Reflect
legitimate stale-claim return to queued or late resolution of unknown. Never invoke
device recovery/attempt RPCs from Apps Script. Project results by immutable Outbox ID
and Submission ID, never row number; recover failed writeback from the journal.

## Intended AUTO rollout and validation

During implementation install paused, validate fake transport and isolated cases,
then the controlled Phase 3B rollout actually uses SMS_ENGINE_MODE=LIVE,
SMS_AUTO_ENABLED=TRUE, the applicable existing SMS switch TRUE and an armed AUTO
campaign. Start with eligible test leads whose real phone is on the explicit
recipient allowlist; no per-row manual approval. Verify both Form and Squarespace
new-lead flow and one scheduled campaign, including intake replay/restart recovery.
The user has requested this rollout behavior; this design-only turn does not
authorize starting the gateway or sending now. The Supabase binding stays disabled
through design and is enabled only in the implementation rollout stage.

Before widening recipients validate: AUTO no-click flow; MANUAL override approval;
no historical welcome; Both email/SMS independence; legacy email-key continuity;
partial audience generation; duplicate form/webhook/household/phone; stale snapshot;
template approval invalidation; exact retries across crashes; all API errors/statuses;
opt-out and HOLD races; concurrent email/SMS log writes; email completion before SMS;
language/GSM-7 boundaries; false success prevention; journal corruption and orphan rows.
No email activation, source-sheet changes, Android changes or backend contract
changes are required merely to roll out AUTO SMS against Phase 3A.
