package com.enrollmentdesk.enrollmentsms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class SmsSentReceiver extends BroadcastReceiver {
  private static final ExecutorService WRITER = Executors.newSingleThreadExecutor();

  @Override
  public void onReceive(Context context, Intent intent) {
    final int code = getResultCode();
    final PendingResult pending = goAsync();
    WRITER.execute(
        () -> {
          try {
            Uri uri = intent.getData();
            if (!SmsGatewayService.ACTION_SMS_SENT.equals(intent.getAction())
                || uri == null
                || !"enrollment-sms".equals(uri.getScheme())
                || !"sent".equals(uri.getHost())) {
              GatewayJournal.get(context).attention("Legacy or invalid callback quarantined");
              DispatchGate.stop();
              return;
            }
            List<String> parts = uri.getPathSegments();
            if (parts.size() != 2) throw new IllegalArgumentException("Invalid callback binding");
            UUID.fromString(parts.get(0));
            UUID.fromString(parts.get(1));
            synchronized (DispatchGate.LOCK) {
              GatewayJournal j = GatewayJournal.get(context);
              j.callback(parts.get(0), parts.get(1), code);
              if (!j.attention().isEmpty()) DispatchGate.stop();
            }
            OutcomeReportWorker.schedulePending(context);
          } catch (Exception storage) {
            GatewayApplication.storageFailed = true;
            DispatchGate.stop();
          } finally {
            pending.finish();
          }
        });
  }
}
