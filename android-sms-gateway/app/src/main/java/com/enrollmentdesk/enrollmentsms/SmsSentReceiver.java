package com.enrollmentdesk.enrollmentsms;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.time.Instant;

public class SmsSentReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int requestCode = intent.getIntExtra(SmsGatewayService.EXTRA_REQUEST_CODE, -1);
        OutboxMessage message = PendingSendStore.pop(context, requestCode);
        if (message == null || message.id.isEmpty()) return;

        try {
            message.metadata.put("android_sent_callback_at", Instant.now().toString());
            message.metadata.put("android_sent_result_code", getResultCode());
        } catch (Exception ignored) {
        }

        String smsMessageId = "android-" + requestCode;
        String error = getResultCode() == Activity.RESULT_OK
                ? null
                : "Android SMS send failed with result code " + getResultCode();

        GatewayConfig config = GatewayConfig.load(context);
        new Thread(() -> {
            try {
                SupabaseGatewayClient client = new SupabaseGatewayClient(config);
                if (error == null) {
                    client.markSent(message.id, smsMessageId, message.metadata);
                } else {
                    client.markFailed(message.id, error, message.metadata);
                }
            } catch (Exception ignored) {
            }
        }).start();
    }
}
