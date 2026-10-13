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
  private final Runnable sessionEnd =
      () -> stopSession("Session ended; start another session explicitly");

  @Override
  public void onCreate() {
    super.onCreate();
    getSystemService(NotificationManager.class)
        .createNotificationChannel(
            new NotificationChannel(
                CHANNEL, "Enrollment SMS Gateway", NotificationManager.IMPORTANCE_LOW));
    startForeground(9101, notification("Starting bounded gateway session"));
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (!DispatchGate.running() || GatewayApplication.storageFailed) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!started) {
      started = true;
      GatewayConfig config = GatewayConfig.load(this);
      GatewayCoordinator coordinator =
          new GatewayCoordinator(
              GatewayJournal.get(this),
              new SupabaseGatewayClient(config),
              new AndroidSmsTransport(this),
              SystemClock::elapsedRealtime,
              DispatchGate.start());
      // An app-level one-hour cap complements (and never resets) the Android 15 platform budget.
      main.postDelayed(sessionEnd, TimeUnit.HOURS.toMillis(1));
      executor.scheduleWithFixedDelay(
          () -> {
            try {
              OutcomeReportWorker.schedulePending(this);
              coordinator.tick();
              if (!DispatchGate.running() || GatewayApplication.storageFailed) {
                main.post(() -> stopSession("Stopped; attention required"));
                return;
              }
              getSystemService(NotificationManager.class)
                  .notify(9101, notification(GatewayJournal.get(this).status()));
            } catch (Exception e) {
              DispatchGate.stop();
              GatewayApplication.storageFailed = true;
              main.post(() -> stopSession("Storage or scheduling error; stopped"));
            }
          },
          0,
          config.pollSeconds,
          TimeUnit.SECONDS);
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onTimeout(int startId, int fgsType) {
    // Do not wait for HTTP or queue work. Invalidate submission rights and stop promptly.
    stopSession("Android foreground-service time budget exhausted");
  }

  private void stopSession(String reason) {
    DispatchGate.stop();
    main.removeCallbacks(sessionEnd);
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
    DispatchGate.stop();
    main.removeCallbacks(sessionEnd);
    executor.shutdownNow();
    super.onDestroy();
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
        .setContentIntent(open)
        .build();
  }
}
