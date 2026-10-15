# Continuous Enrollment gateway (Android 14)

## Source comparison

Nuntium GitHub main was inspected at commit
`73d6aee6a79d8e774393b9b9611efffffe7a228a` (not the Desktop backup).
Source: `android-sms-gateway/app/src/main/java/com/enrollmentdesk/smsgateway/`
`SmsGatewayService.java`, `GatewayConfig.java`, `MainActivity.java`,
`InboundSmsReceiver.java`, plus the manifest and app build configuration.

| Mechanism | Nuntium | Enrollment before this change | Enrollment now |
|---|---|---|---|
| Foreground notification | Ongoing dataSync service | Ongoing dataSync service | Ongoing, with Stop action |
| Normal process death | START_STICKY, persistent enabled preference | START_NOT_STICKY; startup clears enabled | START_STICKY; persistent operator intent |
| Polling | Handler loop while enabled | Scheduled loop, one-hour application timer | Scheduled loop without application session expiry |
| Boot | No receiver | No receiver | BOOT_COMPLETED after unlock on API 34 and below |
| Package upgrade | No dedicated receiver | No dedicated receiver | MY_PACKAGE_REPLACED restores enabled service on API 34 and below |
| WorkManager | Not used | Durable outcome reporting only | Durable outcome reporting only; never a new-send fallback |
| Battery handling | No explicit exemption/wake lock | No continuous-operation setup | Timed, renewed partial wake lock and battery settings link |

Nuntium's inbound receiver can also start its service after an inbound message.
Enrollment remains outbound-only and does not copy that mechanism. Nuntium has no
explicit boot recovery, task-removed restart, Android 15 timeout handler, or
battery optimization setup in the inspected source. Continuous operation there
is not evidence of guaranteed recovery from every device power-management event.

## Android changes and invariants

The dedicated handset is Android 14 / API 34. Target SDK 35 does not impose
Android 15's dataSync time budget on Android 14. The application hour timer is
removed. A new service generation always enters the unchanged coordinator and
SQLite journal: a saved enabled flag is intent to operate, never permission to
replay an attempt. DISPATCH_COMMITTED and unresolved callback states retain the
existing uncertainty/reconciliation behavior. No journal schema, claim/begin
protocol, frozen identity, callback identity, exact ACK, or retry semantics change.

The configured default SMS subscription is pinned when continuous mode is first
enabled. A different/missing default subscription fails preflight; the existing
pre-dispatch SIM recheck remains. The coordinator retains its ten-second minimum
spacing, including a fresh ten-second delay on restart.

Explicit Stop persists disabled before stopping the service. System teardown
invalidates the process generation but preserves enabled intent. Unsafe journal
or configuration conditions disable the service and require attention. Legacy
versions migrate to disabled once; upgrading cannot silently enable sending.

Android 15 retains platform onTimeout handling: disable and stop promptly. Boot
restoration of a dataSync service is deliberately not attempted on API 35+.
No alarm or WorkManager restart loop evades the platform time budget. Supporting
unattended Android 15 requires a separately validated service strategy.

## CRM automation

`installSmsAutomationTriggers()` (also called by the existing
`installSmsWorkerTrigger()`) installs exactly one per-minute `runSmsWorker` and
one per-minute `pollSmsStatuses` trigger for the operator account. Installation
is idempotent and rejects duplicate handlers. Only that operator account should
own SMS triggers; Apps Script does not expose other accounts' triggers here.

Status polling is independently scheduled, so an ingest/planning exception or
SMS_PAUSED does not prevent it. It uses the existing durable observations and
writeback, never retransmits an accepted/unknown message. Existing status
intervals remain: queued five minutes, unknown fifteen minutes, other active
states one minute; terminal sent/failed/cancelled stop polling. Apps Script clock
triggers are approximate and subject to quota, not exact-time dispatch guarantees.
The worker retains its existing bounded work and reservation/duplicate fencing.

## Rollout and operating requirements

1. Install the validated APK without clearing application data. Keep the durable
   journal and configured profile. Keep SMS_PAUSED TRUE and producer disabled.
2. Replace only the generated SmsIntegration.gs bundle in the existing Apps Script
   project. Do not install source modules alongside the bundle. Run validation,
   then install the paired triggers from the designated operator account.
3. Keep the handset powered, online and battery-unrestricted. Select the dedicated
   SMS SIM. Confirm no unresolved journal attention. Android force-stop and an
   unpowered device cannot self-recover. Reboot recovery begins after first unlock;
   Android may defer the BOOT_COMPLETED broadcast during boot congestion.
4. Review eligible CRM audience, permission, template, schedule, campaign policy,
   allowlist and limits. AUTO only processes eligible, armed campaigns; it does
   not override these gates. Do not widen an existing test audience inadvertently.
5. At authorized cutover, restore SMS permission, enable continuous operation once,
   enable the backend producer, and set SMS_PAUSED FALSE. Confirm trigger executions
   and automatic status writeback against ordinary authorized campaign work.
   No additional one-message pilot is required solely for these lifecycle changes.
6. To stop new work, set SMS_PAUSED TRUE and disable producer; use handset Stop.
   Already submitted SMS cannot be recalled. Preserve/report pending outcomes.

Remaining rollout gates: deployed Apps Script bundle and paired triggers, battery
configuration, explicit live enablement, and extended screen-off/Doze observation.
Short restart tests cannot establish a 24-hour availability guarantee.

Platform references:
- https://developer.android.com/reference/android/app/Service#START_STICKY
- https://developer.android.com/develop/background-work/services/fgs/timeout
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/training/monitoring-device-state/doze-standby
- https://developers.google.com/apps-script/guides/triggers/installable
