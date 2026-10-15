package com.enrollmentdesk.enrollmentsms;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.telephony.SubscriptionManager;

/** Persist operator intent, never a right to dispatch an existing attempt. */
final class GatewayLifecycle {
  static boolean enabled(Context c) {
    return c.getSharedPreferences(GatewayConfig.PREFS, 0).getBoolean("enabled", false);
  }

  static void disable(Context c) {
    synchronized (DispatchGate.LOCK) {
      DispatchGate.stop();
      if (!c.getSharedPreferences(GatewayConfig.PREFS, 0)
          .edit()
          .putBoolean("enabled", false)
          .commit()) {
        GatewayApplication.storageFailed = true;
        throw new IllegalStateException("Cannot persist stop");
      }
    }
  }

  static int boundSim(Context c) {
    return c.getSharedPreferences(GatewayConfig.PREFS, 0).getInt("bound_sms_sim", -1);
  }

  static void enable(Context c) throws Exception {
    synchronized (DispatchGate.LOCK) {
      GatewayConfig config = GatewayConfig.load(c);
      GatewayJournal journal = GatewayJournal.get(c);
      journal.requireProfile(config);
      if (GatewayApplication.storageFailed || !config.isReady() || !journal.attention().isEmpty())
        throw new IllegalStateException("Resolve configuration or journal attention first");
      int sim = SubscriptionManager.getDefaultSmsSubscriptionId();
      if (sim < 0 || sim == SubscriptionManager.DEFAULT_SUBSCRIPTION_ID)
        throw new IllegalStateException("Choose the dedicated SMS SIM first");
      int bound = boundSim(c);
      if (bound >= 0 && bound != sim) throw new IllegalStateException("Dedicated SMS SIM changed");
      if (!c.getSharedPreferences(GatewayConfig.PREFS, 0)
          .edit()
          .putBoolean("continuous_initialized", true)
          .putBoolean("enabled", true)
          .putInt("bound_sms_sim", sim)
          .commit()) throw new IllegalStateException("Cannot persist start");
    }
  }

  static boolean restore(Context c) {
    // Android 15 dataSync cannot start at boot. Never use restart loops to evade its budget.
    if (!enabled(c) || Build.VERSION.SDK_INT >= 35 || GatewayApplication.storageFailed)
      return false;
    try {
      c.startForegroundService(new Intent(c, SmsGatewayService.class));
      return true;
    } catch (RuntimeException denied) {
      // Retain intent for a later user-visible recovery; do not spin on a rejected start.
      return false;
    }
  }
}
