package com.enrollmentdesk.enrollmentsms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.telephony.SmsManager;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class SmsGatewayService extends Service {
    static final String ACTION_SMS_SENT = "com.enrollmentdesk.enrollmentsms.SMS_SENT";
    static final String EXTRA_REQUEST_CODE = "request_code";

    private static final String CHANNEL_ID = "enrollment_sms_gateway";
    private static final int NOTIFICATION_ID = 9101;
    private static final long HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000L;
    private static final long MIN_SEND_INTERVAL_MS = 10_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean polling = new AtomicBoolean(false);
    private long lastHeartbeatAtMs = 0L;
    private long lastSendAttemptAtMs = 0L;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            pollOnce();
            GatewayConfig config = GatewayConfig.load(SmsGatewayService.this);
            if (config.enabled) handler.postDelayed(this, config.pollSeconds * 1000L);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification("Enrollment SMS gateway running"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(pollRunnable);
        handler.post(pollRunnable);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(pollRunnable);
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pollOnce() {
        if (!polling.compareAndSet(false, true)) return;

        executor.execute(() -> {
            GatewayConfig config = GatewayConfig.load(this);
            try {
                if (!config.enabled || !config.isReady()) return;

                SupabaseGatewayClient client = new SupabaseGatewayClient(config);
                heartbeatIfDue(client);

                List<OutboxMessage> messages = client.claimQueue(3);
                for (OutboxMessage message : messages) {
                    waitForPacing();
                    sendMessage(client, message);
                }
            } catch (Exception ignored) {
            } finally {
                polling.set(false);
            }
        });
    }

    private void heartbeatIfDue(SupabaseGatewayClient client) throws Exception {
        long now = SystemClock.elapsedRealtime();
        if (lastHeartbeatAtMs == 0L || now - lastHeartbeatAtMs >= HEARTBEAT_INTERVAL_MS) {
            client.heartbeat();
            lastHeartbeatAtMs = now;
        }
    }

    private void waitForPacing() throws InterruptedException {
        if (lastSendAttemptAtMs <= 0L) return;
        long remaining = MIN_SEND_INTERVAL_MS - (SystemClock.elapsedRealtime() - lastSendAttemptAtMs);
        if (remaining > 0L) Thread.sleep(remaining);
    }

    private void sendMessage(SupabaseGatewayClient client, OutboxMessage message) {
        if (message == null || message.id == null || message.id.isEmpty()) return;

        try {
            SmsManager smsManager = getSystemService(SmsManager.class);
            List<String> parts = smsManager.divideMessage(message.body);

            if (parts.size() != 1) {
                client.markFailed(
                        message.id,
                        "Blocked by gateway: message is " + parts.size() + " SMS segments; only 1 segment is allowed.",
                        message.metadata
                );
                return;
            }

            int requestCode = Math.abs((message.id + System.currentTimeMillis()).hashCode());
            Intent sentIntent = new Intent(this, SmsSentReceiver.class)
                    .setAction(ACTION_SMS_SENT)
                    .putExtra(EXTRA_REQUEST_CODE, requestCode);
            PendingIntent sentPendingIntent = PendingIntent.getBroadcast(
                    this,
                    requestCode,
                    sentIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            message.metadata.put("sms_send_attempted_at", Instant.now().toString());
            message.metadata.put("sms_part_count", parts.size());
            PendingSendStore.put(this, requestCode, message);

            lastSendAttemptAtMs = SystemClock.elapsedRealtime();
            smsManager.sendTextMessage(message.phone, null, message.body, sentPendingIntent, null);
        } catch (Exception error) {
            try {
                client.markFailed(message.id, error.getMessage(), message.metadata);
            } catch (Exception ignored) {
            }
        }
    }

    private Notification buildNotification(String text) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("Enrollment SMS Gateway")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Enrollment SMS Gateway",
                NotificationManager.IMPORTANCE_LOW
        );
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
