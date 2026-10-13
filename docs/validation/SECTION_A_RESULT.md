# Section A — stopped physical-device validation

Completed October 12, 2026 on the correct Enrollment handset 02: Moto g play
(2024), Android 14 / API 34, app 2.0.0 / code 2, one active Boost Mobile SIM.
Backend identity: `d800c0ee-12a4-475a-958e-706c69a500cd`.

| Check | Result and evidence |
| --- | --- |
| Fresh installation | Neither gateway package present on handset 02 before install; expected APK hash and version verified |
| Heartbeat and identity | Correct saved project/device/token; backend reports Motorola, Android API 34 and app 2.0.0 |
| Invalid credentials | Test Connection rejected invalid token; saved preferences byte-for-byte unchanged; reopening restored saved values |
| Permissions | SEND_SMS denied throughout Section A; notification permission denied; no SMS gateway service |
| SIM | User reported one Boost SIM; Section B subsequently verified default subscription 2, slot 0, in service |
| Network loss/recovery | No default network offline; visible test failure; exact saved credentials preserved; heartbeat resumed online without queue activity |
| Screen off/unlock | After 30-second lock/unlock, session stopped, no service, SMS denied; backend unchanged |
| Force-stop/reopen | Saved identity and credentials persisted; enabled=false, zero pending outcomes |
| Reboot/reopen | Reboot confirmed by uptime; no service before reopening; permission denied; profile retained afterward |
| Journal baseline | Private stopped snapshot integrity_check=ok; one matching profile; zero requests, attempts, outcomes or active slot; health attention empty |

Screen-off USB visibility was interrupted, so continuous service state during
that interval was not observed. Evidence establishes the before/after states.
This was a stopped-session check, not an active screen-off transport test.

Before the subsequent authorized SMS, backend queue/attempt/claim/log counts were
zero. Online heartbeat resumed at `2026-10-13T01:37:46.043089+00:00`. No SMS was
sent during Section A. Section B's later one-message result is documented separately.

The initial phone was mistakenly identified as fresh; it was reserved for Nuntium.
It was replaced before these acceptance results. The correct phone received its
own token. The old Enrollment identity `802bb08b-47ff-4658-a670-353732f75160` was
disabled during the authorized first-send setup. Nuntium was not changed.

Private credentials, handset serials, real phone numbers and raw journal snapshots
are intentionally excluded. This record is distilled from the interactive ADB
checks, live backend checks and user observations, not a retrospective automated test.
