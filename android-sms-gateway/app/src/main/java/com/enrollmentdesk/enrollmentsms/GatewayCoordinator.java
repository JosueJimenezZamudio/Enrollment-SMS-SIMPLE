package com.enrollmentdesk.enrollmentsms;

import java.io.IOException;
import org.json.JSONObject;

/** One tick at a time, with an injectable transport/clock for crash and race tests. */
final class GatewayCoordinator {
  interface Clock {
    long now();
  }

  interface Transport {
    int preflight(GatewayJournal.Slot slot) throws Exception;

    void submit(GatewayJournal.Slot slot, int sim, String callbackUri) throws Exception;
  }

  static final class PreflightFailure extends Exception {
    PreflightFailure(String safeReason) {
      super(safeReason);
    }
  }

  private final GatewayJournal journal;
  private final SupabaseGatewayClient client;
  private final Transport transport;
  private final Clock clock;
  private final long generation;
  private long nextSendAt, nextPollAt;
  private int failures;

  GatewayCoordinator(
      GatewayJournal journal,
      SupabaseGatewayClient client,
      Transport transport,
      Clock clock,
      long generation) {
    this.journal = journal;
    this.client = client;
    this.transport = transport;
    this.clock = clock;
    this.generation = generation;
    nextSendAt =
        clock.now()
            + 10000; // Full delay after every process/session restart; wall clock never authorizes
    // send.
  }

  synchronized void tick() {
    if (!DispatchGate.valid(generation) || clock.now() < nextPollAt) return;
    try {
      journal.requireProfile(client.config);
      if (!journal.attention().isEmpty()) return;
      GatewayJournal.Slot slot = journal.active();
      if (slot != null && !slot.profile.equals(client.config.profileId))
        throw new IllegalStateException("Profile mismatch");
      if (slot != null && slot.phase.equals("OUTCOME_PENDING")) {
        journal.status("Reporting saved outcome");
        return;
      }
      if (slot == null && clock.now() < nextSendAt) {
        journal.status("Waiting for pacing");
        return;
      }
      String device = client.heartbeat();
      if (!device.equals(client.config.deviceId))
        throw new IllegalStateException("Device identity changed");
      synchronized (DispatchGate.LOCK) {
        // Pause/configuration changes cannot slip between this check and the durable profile
        // binding.
        if (!DispatchGate.valid(generation)) return;
        slot = journal.request(client.config.profileId);
      }
      journal.status(slot.attempt == null ? "Claiming" : "Reconciling saved attempt");
      JSONObject response = client.claim(slot.request);
      journal.accept(
          slot.request, response); // Persist a lost-response recovery even if pause won meanwhile.
      failures = 0;
      nextPollAt = clock.now() + client.config.pollSeconds * 1000L;
      slot = journal.active();
      if (slot == null) {
        journal.status("Ready; queue empty or prior attempt complete");
        return;
      }
      if (!slot.phase.equals("PREPARED")) {
        if (slot.phase.equals("DISPATCH_COMMITTED")) journal.uncertain(slot.attempt);
        journal.status("Unknown outcome / waiting for callback; no resend");
        return;
      }
      if (!DispatchGate.valid(generation)
          || clock.now() < nextSendAt
          || !journal.attention().isEmpty()) return;
      int sim;
      try {
        sim = transport.preflight(slot);
      } catch (PreflightFailure e) {
        journal.preflightFailure(slot.attempt, e.getMessage());
        return;
      }
      String uri = "enrollment-sms://sent/" + slot.profile + "/" + slot.attempt;
      long guardTime;
      synchronized (DispatchGate.LOCK) {
        if (!DispatchGate.valid(generation) || !journal.attention().isEmpty()) return;
        if (!journal.guard(slot.attempt, sim, uri)) return;
        guardTime = clock.now();
      }
      // No recovery code ever enters begin. Transient begin failure abandons this continuation.
      try {
        RpcReceipt begin = client.begin(slot.attempt);
        begin.matches(slot.attempt, slot.queue);
        synchronized (DispatchGate.LOCK) {
          if (!DispatchGate.valid(generation)
              || clock.now() - guardTime >= 60000
              || !begin.state.equals("sending")
              || !journal.dispatchable(slot.attempt)
              || clock.now() < nextSendAt) {
            journal.uncertain(slot.attempt);
            return;
          }
          // SIM and permission can change during HTTP. Recheck without selecting another sender.
          if (transport.preflight(slot) != sim || clock.now() - guardTime >= 60000) {
            journal.uncertain(slot.attempt);
            return;
          }
          nextSendAt = clock.now() + 10000;
          // Durable guard already consumed the only right to submit. Exceptions never become
          // failure reports.
          transport.submit(slot, sim, uri);
          journal.status("Waiting for Android callback");
        }
      } finally {
        journal.uncertain(slot.attempt);
      }
    } catch (Exception error) {
      try {
        boolean retry =
            error instanceof IOException
                && (!(error instanceof SupabaseGatewayClient.RpcError)
                    || ((SupabaseGatewayClient.RpcError) error).retryable);
        if (retry) {
          failures = Math.min(6, failures + 1);
          long delay = Math.min(60000, 5000L * (1L << failures));
          if (error instanceof SupabaseGatewayClient.RpcError)
            delay = Math.max(delay, ((SupabaseGatewayClient.RpcError) error).retryAfterMs);
          nextPollAt = clock.now() + delay;
          journal.status("Disconnected; saved work retained");
        } else {
          journal.attention(
              error instanceof SupabaseGatewayClient.RpcError
                      && SupabaseGatewayClient.authorizationError(
                          (SupabaseGatewayClient.RpcError) error)
                  ? GatewayJournal.AUTH_ATTENTION
                  : "Protocol or storage error; saved work retained");
          DispatchGate.stop();
        }
      } catch (Exception storageFailure) {
        DispatchGate.stop();
      }
    }
  }
}
