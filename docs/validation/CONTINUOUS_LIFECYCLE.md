# Continuous lifecycle validation — 2026-10-14

Branch: production-gateway-lifecycle, based on merged Phase 3B main.

- Apps Script: 80 tests passed, including paired-trigger idempotence and independent
  status writeback while paused; no ingest call from that status check.
- Android: 90 unit test executions passed (72 reliability plus 18 lifecycle across
  API 34/35). One live-RPC test intentionally skipped. Debug APK and lint succeeded;
  lint retains dependency/UI warnings, no errors.
- Physical handset: Android 14 / API 34, target SDK 35. Existing package upgraded
  in place, no application-data clearing. Private backups retained outside Git.
- Safety: producer disabled; backend held only two sent rows. SEND_SMS app-op
  remained ignore. No new test message/queue item was inserted.
- Continuous intent was configured for the no-send test with existing bound SIM 2.
  Foreground service reported START_STICKY and ongoing notification.
- Killed the app process with SIGKILL (not force-stop), with activity backgrounded.
  Android recreated the foreground service and recorded restartCount=1 without
  operator Start. No outcome replay.
- Rebooted handset. After unlock and Android's deferred boot-broadcast delivery,
  service restarted with allowStartForeground=BOOT_COMPLETED and START_STICKY.
  No activity launch or manual Start was used for that recovery.
- Tapped the actual Stop button. Persisted enabled=false and service absent.
- Before/after SQLite rows for profiles (1), attempts (2), outcomes (2) were exactly
  unchanged. Existing callback/ACK records were preserved.

Not claimed: an elapsed 24-hour soak, Android 15 physical support, force-stop
recovery, battery-exempt Doze validation, or live deployment of the new Apps Script
bundle/triggers. These remain rollout/operating checks. No additional physical SMS
was needed or sent for lifecycle validation.
