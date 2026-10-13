# First controlled SMS — PASS

Executed October 12, 2026, at approximately 7:03 PM America/Los_Angeles (PDT).
The owner explicitly authorized one real SMS to their own private test number.
Only one queue row and one send attempt were created. No SMS retry was performed.

Message: `Enrollment SMS test - first controlled send.`

## Verified identity and preflight

- Handset: Moto g play (2024), Android 14 / API 34; dedicated handset 02.
- App: Enrollment SMS Gateway 2.0.0, dedicated Supabase project `rccdxrmyavihzdrgokpv`.
- Device identity: `d800c0ee-12a4-475a-958e-706c69a500cd`.
- Saved URL, public key and handset token compared against the provisioned values without printing credentials.
- Default SMS subscription: **2**, active in SIM slot **0**, carrier **Boost**, voice/data in service. The older subscription 1 was inactive history, not a second active SIM.
- Local journal integrity `ok`, one saved profile, zero requests/attempts/outcomes, no attention before execution.
- SMS and notification permissions granted for the test; foreground service and active session verified while backend queue was still empty.
- Earlier unused Enrollment identity disabled before insertion; Nuntium app, configuration and backend were not changed.

## Exact backend and local evidence

| Field | Value |
| --- | --- |
| Queue ID | `5db1073a-021f-4b99-847f-1cba68c56af8` |
| Attempt ID | `6ac33d07-1fbe-4bd4-b4e0-161446511185` |
| Claim request ID | `80fb50b7-9961-4892-89e1-7f5ac74ee6eb` |
| Outcome event ID | `4760d19e-d3a6-4401-b5ea-08bf8085c4da` |
| Dedupe key | `phase2:first-physical:handset02:001` |
| Backend queue state / attempt state | `sent` / `sent` |
| Total queue rows / attempts / send logs | **1 / 1 / 1** |
| Send-log ID | `9` (sequence values include earlier removed synthetic fixtures; current log count is one) |
| Outcome source / Android result | `android_callback` / `-1` (`RESULT_OK`) |
| Local phase / acked / blocked | `ACKNOWLEDGED` / `1` / `0` |
| Local request active / total active requests | `0` / `0` |
| Unacknowledged outcomes / health attention | `0` / empty |
| Recorded submission SIM | `2`, matching the verified Boost default |
| Journal integrity | `ok` |

Timeline (UTC; local time is seven hours earlier):

1. Queue insertion observed as `queued`: `2026-10-13T02:03:32.951218+00:00`.
2. Claim persisted: `2026-10-13T02:03:36.891909+00:00`.
3. Local dispatch guard persisted: `2026-10-13T02:03:37.002176Z`.
4. Backend send authorization (`sending`): `2026-10-13T02:03:37.086959+00:00`.
5. Android callback recorded locally: `2026-10-13T02:03:37.726397Z`.
6. Backend `sent` completion and one log: `2026-10-13T02:03:37.887185+00:00`.
7. Local acknowledgment was persisted and verified afterward. Its stored receipt has that **exact backend completion timestamp**, queue ID, attempt ID, outcome event ID and state `sent`.

The brief claimed/sending states are evidenced by their persisted timestamps;
polling first saw the terminal state after insertion. Backend `sent` commits before
its ACK reaches the phone. The local ACK was independently read from a stopped,
private journal snapshot and programmatically compared to the live backend.
Phone and server timestamps come from separate clocks; correlation uses IDs and
receipt equality, not assumptions about clock synchronization.

## Physical receipt

The owner confirmed: **“One message arrived from the expected sender.”**
The question explicitly named the exact message and intended Boost SIM sender.
This is recipient confirmation for this test, separate from Android's send callback.
No claim is made that all future SMS deliveries are guaranteed.

## Final containment

- Stop button invoked after terminal success, then the Enrollment app force-stopped for journal evidence collection.
- `SEND_SMS` revoked and verified `granted=false`.
- No Enrollment service running; package verified `stopped=true`.
- Correct handset's backend identity remains enabled for authentication; this does not enable phone sending.
- Earlier unused Enrollment identity `802bb08b-47ff-4658-a670-353732f75160` is **disabled**. It should remain disabled because that handset is reserved for Nuntium.
- Terminal queue, attempt, claim receipt, local outcome and send log retained. No reset, deletion, requeue or second SMS.
- Notification permission remains granted; SMS permission does not.

Raw credentials, the full recipient number, and private journal snapshots are not
included in this report. Identifier-only evidence:
[backend](execution-backend-evidence.json) · [local journal/ACK](execution-local-evidence.json).

Apps Script, Sheets, Nuntium and application source code were unchanged. At execution time nothing
was merged. Repository cutover was authorized afterward. This validates the first-send happy path only; fault-injection cases,
two-send pacing and Android 15 timeout behavior remain untested on physical hardware.
