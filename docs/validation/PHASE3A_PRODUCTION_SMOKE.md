# Phase 3A stopped production validation — 2026-10-13

**Passed.** Deployed implementation commit
`8ceabf1f6fda82281c7b090350dbd3e0a8d66e5b` to dedicated project
`rccdxrmyavihzdrgokpv` (Enrollment-SMS-SIMPLE, Enrollment Desk, us-west-1).
PR #3 remains unmerged. No Apps Script, Sheet or Android code changed.

## Deployment and final configuration

- Applied only forward migration `20261013023711_producer_ingest_receipts.sql`.
  MCP initially assigned version `20261013184935`; its history entry was aligned
  to the repository filename. No deployed SQL was rewritten or replayed.
- Deployed `queue-enrollment-sms` version 1, ID `a5be4544-1e27-4b93-a7e7-66c32c0d6ebe`.
- Deployed `sms-queue-status` version 1, ID `89068a6f-3c01-4eda-b80c-acbab8d36bda`.
- Both functions use custom shared-secret authentication (`verify_jwt=false`).
  Their existing server-side Supabase credential never goes to a client.
- Configured distinct random `LEAD_SMS_INGEST_SECRET` and `LEAD_SMS_STATUS_SECRET`.
  The owner saved these through the CLI because the agent's CLI could not access
  the owner's saved login. Authenticated HTTPS checks verified both values worked
  and neither endpoint accepted the other's credential. No secret is in this report.
- `SMS_INGEST_CLIENT_ID=enrollment-sheet-worker`; its final binding is handset 02,
  `d800c0ee-12a4-475a-958e-706c69a500cd`, with **enabled=false**.
  Correctly authenticated ingestion now returns 503 `Ingest client unavailable`.
  This is deliberate containment, not a failed deployment.

## Safety and fixture scope

ADB showed no connected phone. We did not start a gateway, grant SMS permission,
call a device claim/begin/terminal RPC, or authorize a real send. The physical phone's
screen/permission state was not freshly observed; the previously validated stopped
state is supported by unchanged backend heartbeat and claim evidence.

During tests, the producer was temporarily bound to two disposable synthetic device
identities. They had random token hashes with no usable handset token provisioned.
All queued fixtures used the reserved fictional number `+12025550123`, a literal
synthetic message and a frozen schedule in 2099. Nothing was routed to the real
handset. A second scoped synthetic client exercised ownership isolation. Changing
routing meant changing the synthetic client's server binding, not accepting a
routing override from a request body.

One primary HTTP submission produced queue `35159b6b-2f19-4be3-8bbc-2ad81828fa40`.
A second queue, `fa489123-0f14-4e02-8424-89af4f04ada2`, was inserted through the deployed
service-role RPC for the other-client ownership fixture. These were two independent
synthetic identities, not duplicate submissions of the primary message.

## Production results

The [sanitized machine-readable evidence](PHASE3A_PRODUCTION_SMOKE.json) records
22 HTTPS checks, response bodies and UTC observation timestamps. The main checks
ran around 11:57–11:58 AM Pacific; post-cleanup containment checks passed at 2:29 PM
Pacific after the task resumed. Both fixtures remained queued with zero attempts
throughout that interval.

| Check | Result |
| --- | --- |
| Missing/wrong ingest secret | 401 |
| Missing/wrong status secret | 401 |
| Read credential used for ingest; ingest credential used for read | Both 401 |
| First frozen synthetic ingest | 201, queue ID and queued state |
| Identical retry | 200, duplicate=true, exact same queue ID and receipt |
| Same key with changed message | 409 DEDUPE_CONFLICT |
| Same key with changed schedule | 409 DEDUPE_CONFLICT |
| Same key after synthetic routing change | 409 DEDUPE_CONFLICT |
| Same key owned by another client | 409 DEDUPE_CONFLICT, no receipt disclosed |
| Status by ID, dedupe key, and both matching selectors | 200, identical item |
| Status projection | Exactly nine documented fields, no contact/body/device/token data |
| Other-client item by ID or key | 404 |
| Nonexistent ID/key and mismatched selectors | 404 |
| Primary queue count after all primary retries/conflicts | Exactly one |
| Both synthetic queue items before removal | queued, attempts=0, claimed_at/current_attempt_id=null |
| Final disabled producer ingest | 503, no queue insertion |
| Removed fixture lookup | 404 |

The nine status fields were `id`, `dedupe_key`, `status`, `scheduled_at`, `claimed_at`,
`sent_at`, `failed_at`, `last_error`, and `attempt_status`.

The deployed PostgreSQL RPCs also passed all **65 rollback-only assertions**, covering
all terminal/nonterminal states and SQL privilege boundaries. Those transactional
fixtures were never visible to other sessions and left no rows behind. Previous
42 local TypeScript/HTTP checks and three isolated concurrency scenarios remain
recorded in the contract guide; those are distinct from these production HTTP checks.

## Cleanup and preserved evidence

Disabled ingestion, verified both test queues had no attempt, then removed only their
two receipt/queue rows, the extra client, and both synthetic devices. Restored the
future Sheet producer's real handset binding while leaving it disabled.

Final application data: **one queue row, one attempt, one send log, ten claim receipts,
zero ingest receipts, two original device identities, one disabled producer**.
The queue, attempt and log remain the original Section B sent evidence. Checksums
of complete sorted JSONB rows matched the pre-test values exactly:

| Table | Before and after fingerprint |
| --- | --- |
| sms_queue | `815be0b175c00a2c146f64a81d729659` |
| sms_send_attempts | `858810e80faa89ff95a49cc49581a571` |
| sms_send_log | `410c0ea7fd163107b9e0ad1ee77de1ca` |

These database-generated MD5 values are change-detection evidence, not cryptographic
attestations. No raw Section B recipient, message or credentials were exported.
Handset 02's last heartbeat remained `2026-10-13T02:03:52.487655Z`; the older Enrollment
identity remains disabled. No new claim, send authorization, callback or sent log
occurred. No SMS was sent by this validation.

## Advisors and remaining scope

Security advisors show intentional default-deny RLS without policies on producer
tables and the previously documented device-token RPC warnings. No new producer
SECURITY DEFINER exposure or missing foreign-key index was reported. Performance
information reports unused new indexes on this nearly empty dataset; retain them.
See [RLS advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
and [unused-index advisory](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).

The deployment and stopped production checks are complete. Review/merge of PR #3
and the dynamic Sheet/Apps Script implementation are separate next steps. Leave the
producer disabled and gateway stopped until a later authorized rollout. Do not
confuse successful backend smoke checks with a new physical-device SMS test.
