package com.enrollmentdesk.enrollmentsms;

import android.app.*;
import android.content.Intent;
import android.os.*;
import java.util.concurrent.*;

public class SmsGatewayService extends Service {
  static final String ACTION_SMS_SENT = "com.enrollmentdesk.enrollmentsms.SMS_SENT";
  private static final String CHANNEL = "enrollment_sms_gateway";
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
  private boolean started;
  private volatile boolean destroyed;
  private PowerManager.WakeLock wakeLock;

  @Override
  public void onCreate() {
    super.onCreate();
    getSystemService(NotificationManager.class)
        .createNotificationChannel(
            new NotificationChannel(
                CHANNEL, "Enrollment SMS Gateway", NotificationManager.IMPORTANCE_LOW));
    startForeground(9101, notification("Restoring gateway; checking saved work"));
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "STOP".equals(intent.getAction())) {
      stopSession("Stopped by operator");
      return START_NOT_STICKY;
    }
    if (!GatewayLifecycle.enabled(this) || GatewayApplication.storageFailed) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!started) {
      started = true;
      GatewayConfig config = GatewayConfig.load(this);
      try {
        GatewayJournal.get(this).requireProfile(config);
        if (!config.isReady() || !GatewayJournal.get(this).attention().isEmpty()) {
          stopSession("Attention required; saved work retained");
          return START_NOT_STICKY;
        }
      } catch (Exception error) {
        stopSession("Journal unavailable; stopped");
        return START_NOT_STICKY;
      }
      // Invalidate old in-process continuations before restoring a service owner.
      DispatchGate.stop();
      wakeLock =
          getSystemService(PowerManager.class)
              .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EnrollmentSMS:polling");
      wakeLock.setReferenceCounted(false);
      wakeLock.acquire(TimeUnit.MINUTES.toMillis(10));
      GatewayCoordinator coordinator =
          new GatewayCoordinator(
              GatewayJournal.get(this),
              new SupabaseGatewayClient(config),
              new AndroidSmsTransport(this),
              SystemClock::elapsedRealtime,
              DispatchGate.start());
      // No app session deadline. Android 15 still invokes onTimeout for its platform budget.
      executor.scheduleWithFixedDelay(
          () -> {
            try {
              if (destroyed) return;
              if (!GatewayLifecycle.enabled(this)) {
                postStop("Stopped by operator");
                return;
              }
              wakeLock.acquire(TimeUnit.MINUTES.toMillis(10));
              OutcomeReportWorker.schedulePending(this);
              coordinator.tick();
              if (!DispatchGate.running() || GatewayApplication.storageFailed) {
                postStop("Stopped; attention required");
                return;
              }
              getSystemService(NotificationManager.class)
                  .notify(9101, notification(GatewayJournal.get(this).status()));
            } catch (Exception e) {
              if (destroyed) return;
              DispatchGate.stop();
              GatewayApplication.storageFailed = true;
              postStop("Storage or scheduling error; stopped");
            }
          },
          0,
          config.pollSeconds,
          TimeUnit.SECONDS);
    }
    return START_STICKY;
  }

  @Override
  public void onTimeout(int startId, int fgsType) {
    // Do not wait for HTTP or queue work. Invalidate submission rights and stop promptly.
    stopSession("Android foreground-service time budget exhausted");
  }

  private void postStop(String reason) {
    main.post(
        () -> {
          if (!destroyed) stopSession(reason);
        });
  }

  private void stopSession(String reason) {
    try {
      GatewayLifecycle.disable(this);
    } catch (Exception ignored) {
      GatewayApplication.storageFailed = true;
    }
    releaseWakeLock();
    executor.shutdownNow();
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
    try {
      GatewayJournal.get(this).status(reason);
    } catch (Exception e) {
      GatewayApplication.storageFailed = true;
    }
  }

  @Override
  public void onDestroy() {
    destroyed = true;
    main.removeCallbacksAndMessages(null);
    DispatchGate.stop();
    releaseWakeLock();
    executor.shutdownNow();
    super.onDestroy();
  }

  private void releaseWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private Notification notification(String text) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(this, CHANNEL)
        .setContentTitle("Enrollment SMS Gateway")
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
        .setOngoing(true)
        .addAction(
            new Notification.Action.Builder(
                    null,
                    "Stop",
                    PendingIntent.getService(
                        this,
                        1,
                        new Intent(this, SmsGatewayService.class).setAction("STOP"),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build())
        .setContentIntent(open)
        .build();
  }
}
