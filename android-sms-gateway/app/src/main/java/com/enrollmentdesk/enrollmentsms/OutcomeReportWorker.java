package com.enrollmentdesk.enrollmentsms;

import android.content.Context;
import androidx.work.*;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Upload only. The only claim operation is replay of an existing outcome's original request. */
public class OutcomeReportWorker extends Worker {
  public OutcomeReportWorker(Context c, WorkerParameters p) {
    super(c, p);
  }

  static void schedulePending(Context c) {
    for (GatewayJournal.Outcome o : GatewayJournal.get(c).pending()) {
      OneTimeWorkRequest work =
          new OneTimeWorkRequest.Builder(OutcomeReportWorker.class)
              .setInputData(new Data.Builder().putString("attempt", o.attempt).build())
              .setConstraints(
                  new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
              .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
              .build();
      WorkManager.getInstance(c)
          .enqueueUniqueWork("sms-outcome:" + o.event, ExistingWorkPolicy.KEEP, work);
    }
  }

  @Override
  public Result doWork() {
    if (GatewayApplication.storageFailed) return Result.failure();
    try {
      GatewayJournal journal = GatewayJournal.get(getApplicationContext());
      GatewayJournal.Outcome o = journal.outcome(getInputData().getString("attempt"));
      return reportSaved(
          journal, new SupabaseGatewayClient(GatewayConfig.load(getApplicationContext())), o);
    } catch (Exception storage) {
      return storageFailure();
    }
  }

  /**
   * Shared with deterministic tests; receives the same immutable data the worker loads on restart.
   */
  static Result reportSaved(
      GatewayJournal journal, SupabaseGatewayClient client, GatewayJournal.Outcome o) {
    if (o == null) return Result.success();
    try {
      o =
          journal.outcome(
              o.attempt); // A duplicate worker may already have acknowledged or blocked it.
      if (o == null || o.blocked || o.acked) return Result.success();
      if (journal.reportNotBefore(o.attempt) > System.currentTimeMillis()) return Result.retry();
      journal.requireProfile(client.config);
      if (!client.config.profileId.equals(o.profile))
        throw new IllegalStateException("Report profile mismatch");
      journal.acknowledge(o, client.report(o.kind, o.payload));
      return Result.success();
    } catch (SupabaseGatewayClient.RpcError e) {
      try {
        if (e.retryable) {
          journal.deferReport(o.attempt, e.retryAfterMs);
          return Result.retry();
        }
        if (e.code.equals("55000")) {
          journal.accept(o.request, client.claim(o.request));
          GatewayJournal.Slot active = journal.active();
          if (active == null || !o.attempt.equals(active.attempt)) return Result.success();
        }
        journal.block(
            o,
            SupabaseGatewayClient.authorizationError(e)
                ? GatewayJournal.AUTH_ATTENTION
                : "Terminal report rejected (" + e.code + "); evidence retained");
        DispatchGate.stop();
        return Result.failure();
      } catch (SupabaseGatewayClient.RpcError reconciliationError) {
        try {
          if (reconciliationError.retryable) return Result.retry();
          journal.block(
              o,
              SupabaseGatewayClient.authorizationError(reconciliationError)
                  ? GatewayJournal.AUTH_ATTENTION
                  : "Reconciliation rejected; operator review required");
          DispatchGate.stop();
          return Result.failure();
        } catch (Exception storage) {
          return storageFailure();
        }
      } catch (IOException network) {
        return Result.retry();
      } catch (Exception failure) {
        return storageFailure();
      }
    } catch (IOException network) {
      return Result.retry();
    } catch (Exception failure) {
      try {
        // Do not turn a stale duplicate worker into a new profile's attention incident.
        GatewayJournal.Outcome latest = journal.outcome(o.attempt);
        if (latest != null && latest.acked) return Result.success();
        journal.block(o, "Invalid acknowledgment or profile; evidence retained");
        DispatchGate.stop();
      } catch (Exception storage) {
        return storageFailure();
      }
      return Result.failure();
    }
  }

  private static Result storageFailure() {
    GatewayApplication.storageFailed = true;
    DispatchGate.stop();
    return Result.failure();
  }
}
