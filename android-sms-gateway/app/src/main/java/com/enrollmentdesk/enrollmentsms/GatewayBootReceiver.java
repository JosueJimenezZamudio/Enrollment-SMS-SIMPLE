package com.enrollmentdesk.enrollmentsms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Credential-protected journal is opened only after the first unlock following reboot. */
public class GatewayBootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent == null ? null : intent.getAction();
    if (Intent.ACTION_BOOT_COMPLETED.equals(action)
        || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) GatewayLifecycle.restore(context);
  }
}
