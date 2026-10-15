package com.enrollmentdesk.enrollmentsms;

import android.app.Application;

public class GatewayApplication extends Application {
  static volatile boolean storageFailed;

  @Override
  public void onCreate() {
    super.onCreate();
    try {
      GatewayConfig.initialize(this);
      GatewayJournal.get(this)
          .status(
              GatewayLifecycle.enabled(this)
                  ? "Restoring enabled gateway; reconciling saved work"
                  : "Stopped; saved work retained");
      OutcomeReportWorker.schedulePending(this);
    } catch (Exception e) {
      storageFailed = true;
      DispatchGate.stop();
    }
  }
}
