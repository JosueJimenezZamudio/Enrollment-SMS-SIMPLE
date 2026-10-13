package com.enrollmentdesk.enrollmentsms;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(
    sdk = {26, 35},
    application = Application.class)
public class ReliabilityTest {
  Context context;
  GatewayJournal journal;
  FakeClient client;
  FakeTransport transport;
  FakeClock clock;
  String profile, device, attempt, queue;
  long generation;

  static class FakeClock implements GatewayCoordinator.Clock {
    long time = 100000;

    public long now() {
      return time;
    }
  }

  class FakeClient extends SupabaseGatewayClient {
    String server = "claimed", lastRequest;
    int claims, begins, reports;
    boolean loseClaim, loseBegin, pauseBegin, loseAck, crashBegin;
    long beginDelay;
    String reportError;
    boolean wrongAck;

    FakeClient() {
      super(
          new GatewayConfig(
              "https://example.supabase.co",
              "sb_publishable_test",
              "test-device-token",
              5,
              profile,
              device));
    }

    @Override
    String heartbeat() {
      return device;
    }

    @Override
    JSONObject claim(String request) throws Exception {
      claims++;
      lastRequest = request;
      if (loseClaim) {
        loseClaim = false;
        throw new IOException("simulated lost response");
      }
      return claimReceipt(request, server);
    }

    @Override
    RpcReceipt begin(String id) throws Exception {
      begins++;
      server = "sending";
      clock.time += beginDelay;
      if (pauseBegin) DispatchGate.stop();
      if (crashBegin) throw new AssertionError("process death after begin committed");
      if (loseBegin) throw new IOException("simulated lost begin response");
      return new RpcReceipt(receipt(server));
    }

    @Override
    RpcReceipt report(String kind, String payload) throws Exception {
      reports++;
      if (reportError != null) throw new RpcError(400, reportError, 0);
      JSONObject p = new JSONObject(payload);
      JSONObject r = receipt(kind).put("outcome_event_id", p.getString("p_outcome_event_id"));
      if (wrongAck) r.put("outcome_event_id", UUID.randomUUID().toString());
      if (loseAck) {
        loseAck = false;
        throw new IOException("lost ACK");
      }
      return new RpcReceipt(r);
    }
  }

  class FakeTransport implements GatewayCoordinator.Transport {
    int sends, preflights;
    boolean reject, throwsOnSubmit, changeSim;

    public int preflight(GatewayJournal.Slot s) throws Exception {
      preflights++;
      if (reject) throw new GatewayCoordinator.PreflightFailure("one segment required");
      return changeSim && preflights > 1 ? 2 : 1;
    }

    public void submit(GatewayJournal.Slot s, int sim, String uri) throws Exception {
      sends++;
      assertTrue(uri.contains(s.attempt));
      if (throwsOnSubmit) throw new IOException("uncertain binder result");
    }
  }

  @Before
  public void setup() throws Exception {
    DispatchGate.stop();
    GatewayApplication.storageFailed = false;
    context = RuntimeEnvironment.getApplication();
    context.deleteDatabase("gateway-journal.db");
    journal = new GatewayJournal(context);
    profile = UUID.randomUUID().toString();
    device = UUID.randomUUID().toString();
    attempt = UUID.randomUUID().toString();
    queue = UUID.randomUUID().toString();
    journal.profile(profile, "https://example.supabase.co", device);
    client = new FakeClient();
    transport = new FakeTransport();
    clock = new FakeClock();
    generation = DispatchGate.start();
  }

  @After
  public void cleanup() {
    DispatchGate.stop();
    journal.close();
  }

  JSONObject receipt(String state) throws Exception {
    boolean authorized = state.equals("sending") || state.equals("unknown") || state.equals("sent");
    boolean terminal = state.equals("sent") || state.equals("failed");
    return new JSONObject()
        .put("attempt_id", attempt)
        .put("queue_id", queue)
        .put("state", state)
        .put("claim_expires_at", "2026-10-12T00:02:00+00:00")
        .put("send_authorized_at", authorized ? "2026-10-12T00:00:00+00:00" : JSONObject.NULL)
        .put("outcome_due_at", authorized ? "2026-10-12T00:05:00+00:00" : JSONObject.NULL)
        .put("completed_at", terminal ? "2026-10-12T00:01:00+00:00" : JSONObject.NULL)
        .put("outcome_event_id", terminal ? UUID.randomUUID().toString() : JSONObject.NULL);
  }

  JSONObject claimReceipt(String request, String state) throws Exception {
    return receipt(state)
        .put("result", state)
        .put("claim_request_id", request)
        .put(
            "message",
            state.equals("claimed")
                ? new JSONObject()
                    .put("id", queue)
                    .put("to_phone", "+12025550100")
                    .put("body", "Test only")
                    .put("metadata", new JSONObject())
                : JSONObject.NULL);
  }

  GatewayCoordinator coordinator() {
    return new GatewayCoordinator(journal, client, transport, clock, generation);
  }

  void runEligible(GatewayCoordinator coordinator) {
    clock.time += 10000;
    coordinator.tick();
  }

  void prepared() throws Exception {
    GatewayJournal.Slot s = journal.request(profile);
    journal.accept(s.request, claimReceipt(s.request, "claimed"));
  }

  void guarded() throws Exception {
    prepared();
    assertTrue(journal.guard(attempt, 1, "test-uri"));
  }

  @Test
  public void lostClaimUsesPersistedRequestAcrossReopen() throws Exception {
    client.loseClaim = true;
    runEligible(coordinator());
    String request = journal.active().request;
    journal.close();
    journal = new GatewayJournal(context);
    runEligible(coordinator());
    assertEquals(request, client.lastRequest);
    assertEquals(1, transport.sends);
  }

  @Test
  public void restartAfterGuardNeverBeginsOrSends() throws Exception {
    guarded();
    journal.close();
    journal = new GatewayJournal(context);
    runEligible(coordinator());
    assertEquals(0, client.begins);
    assertEquals(0, transport.sends);
    assertEquals("UNCERTAIN", journal.active().phase);
  }

  @Test
  public void lostBeginDoesNotAuthorizeRestart() throws Exception {
    client.loseBegin = true;
    GatewayCoordinator c = coordinator();
    runEligible(c);
    assertEquals(0, transport.sends);
    clock.time += 60000;
    runEligible(coordinator());
    assertEquals(1, client.begins);
    assertEquals(0, transport.sends);
  }

  @Test
  public void deathAfterBeginDoesNotReplaySubmission() throws Exception {
    client.crashBegin = true;
    assertThrows(AssertionError.class, () -> runEligible(coordinator()));
    client.crashBegin = false;
    runEligible(coordinator());
    assertEquals(1, client.begins);
    assertEquals(0, transport.sends);
  }

  @Test
  public void restartAfterSmsSubmissionDoesNotResend() throws Exception {
    runEligible(coordinator());
    assertEquals(1, transport.sends);
    journal.close();
    journal = new GatewayJournal(context);
    runEligible(coordinator());
    assertEquals(1, transport.sends);
  }

  @Test
  public void pauseDuringBeginDiscardsDelayedAuthorization() {
    client.pauseBegin = true;
    runEligible(coordinator());
    assertEquals(0, transport.sends);
  }

  @Test
  public void changedSimDuringBeginDoesNotSend() {
    transport.changeSim = true;
    runEligible(coordinator());
    assertEquals(0, transport.sends);
  }

  @Test
  public void transportExceptionIsUnknownNotKnownFailure() {
    transport.throwsOnSubmit = true;
    runEligible(coordinator());
    assertEquals(1, transport.sends);
    assertNull(journal.outcome(attempt));
    assertEquals("UNCERTAIN", journal.active().phase);
  }

  @Test
  public void duplicateCoordinatorsCanSubmitOnlyOnce() throws Exception {
    GatewayCoordinator a = coordinator(), b = coordinator();
    clock.time += 10000;
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<?> x = pool.submit(a::tick), y = pool.submit(b::tick);
      x.get();
      y.get();
      assertTrue(transport.sends <= 1);
      assertEquals(1, client.begins);
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  public void duplicateGuardHasOneWinner() throws Exception {
    prepared();
    assertTrue(journal.guard(attempt, 1, "uri"));
    assertFalse(journal.guard(attempt, 1, "uri"));
  }

  @Test
  public void guardCommitFailurePreventsBeginAndSms() throws Exception {
    prepared();
    journal
        .getWritableDatabase()
        .execSQL(
            "CREATE TRIGGER fail_guard BEFORE UPDATE OF guard_at ON attempts BEGIN SELECT"
                + " RAISE(ABORT,'disk full'); END");
    runEligible(coordinator());
    assertEquals(0, client.begins);
    assertEquals(0, transport.sends);
    assertEquals("PREPARED", journal.active().phase);
  }

  @Test
  public void immutableOutcomeSurvivesDuplicateCallbackAndLostAck() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    String payload = o.payload;
    journal.callback(profile, attempt, Activity.RESULT_OK);
    assertEquals(payload, journal.outcome(attempt).payload);
    client.loseAck = true;
    GatewayJournal.Outcome firstOutcome = o;
    assertThrows(IOException.class, () -> client.report(firstOutcome.kind, firstOutcome.payload));
    journal.close();
    journal = new GatewayJournal(context);
    o = journal.outcome(attempt);
    assertEquals(payload, o.payload);
    journal.acknowledge(o, client.report(o.kind, o.payload));
    assertNull(journal.active());
    assertTrue(journal.pending().isEmpty());
    journal.callback(profile, attempt, Activity.RESULT_OK);
    assertEquals(payload, journal.outcome(attempt).payload);
  }

  @Test
  public void lostLocalAckCommitRetainsOutcomeForExactRetry() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    RpcReceipt ack = client.report(o.kind, o.payload);
    journal
        .getWritableDatabase()
        .execSQL(
            "CREATE TRIGGER fail_ack BEFORE UPDATE OF acked ON outcomes BEGIN SELECT"
                + " RAISE(ABORT,'disk full'); END");
    assertThrows(Exception.class, () -> journal.acknowledge(o, ack));
    assertNotNull(journal.active());
    assertEquals(o.payload, journal.pending().get(0).payload);
    journal.getWritableDatabase().execSQL("DROP TRIGGER fail_ack");
    journal.acknowledge(o, ack);
    assertNull(journal.active());
  }

  @Test
  public void conflictingCallbacksKeepFirstOutcomeAndBlock() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    String first = journal.outcome(attempt).payload;
    journal.callback(profile, attempt, 1);
    assertEquals(first, journal.outcome(attempt).payload);
    assertTrue(journal.outcome(attempt).blocked);
    assertFalse(journal.attention().isEmpty());
  }

  @Test
  public void wrongProfileCallbackCannotReport() throws Exception {
    guarded();
    journal.callback(UUID.randomUUID().toString(), attempt, Activity.RESULT_OK);
    assertNull(journal.outcome(attempt));
    assertFalse(journal.attention().isEmpty());
  }

  @Test
  public void malformedAckNeverReleasesSlot() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    assertThrows(Exception.class, () -> new RpcReceipt(new JSONObject()));
    RpcReceipt wrong = new RpcReceipt(receipt("sent"));
    assertThrows(Exception.class, () -> journal.acknowledge(o, wrong));
    assertNotNull(journal.active());
    assertEquals(1, journal.pending().size());
  }

  @Test
  public void pendingOutcomeBlocksNewClaims() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    runEligible(coordinator());
    assertEquals(0, client.claims);
    assertEquals(0, transport.sends);
  }

  @Test
  public void onlyConfirmedUnstartedExpiryReleasesAbandonedGuard() throws Exception {
    guarded();
    String request = journal.active().request;
    journal.accept(request, claimReceipt(request, "claimed"));
    assertNotNull(journal.active());
    journal.accept(request, claimReceipt(request, "expired"));
    assertNull(journal.active());
  }

  @Test
  public void unknownKeepsSlotAndAcceptsLateCallback() throws Exception {
    guarded();
    String request = journal.active().request;
    journal.accept(request, claimReceipt(request, "unknown"));
    assertNotNull(journal.active());
    journal.callback(profile, attempt, Activity.RESULT_OK);
    assertEquals("OUTCOME_PENDING", journal.active().phase);
  }

  @Test
  public void preflightRejectionHasDurableFailureWithoutBegin() throws Exception {
    transport.reject = true;
    runEligible(coordinator());
    assertEquals(0, client.begins);
    assertEquals(0, transport.sends);
    assertEquals("failed", journal.outcome(attempt).kind);
  }

  @Test
  public void busyReceiptRequiresAttention() throws Exception {
    GatewayJournal.Slot s = journal.request(profile);
    journal.accept(
        s.request,
        new JSONObject()
            .put("result", "busy")
            .put("claim_request_id", s.request)
            .put("attempt_id", JSONObject.NULL));
    runEligible(coordinator());
    assertEquals(0, client.claims);
    assertFalse(journal.attention().isEmpty());
  }

  @Test
  public void emptyRequestRetiresAndNextPollGetsNewId() throws Exception {
    GatewayJournal.Slot s = journal.request(profile);
    journal.accept(
        s.request,
        new JSONObject()
            .put("result", "empty")
            .put("claim_request_id", s.request)
            .put("attempt_id", JSONObject.NULL));
    assertNull(journal.active());
    assertNotEquals(s.request, journal.request(profile).request);
  }

  @Test
  public void tenSecondRestartPacingUsesMonotonicClock() {
    GatewayCoordinator c = coordinator();
    c.tick();
    assertEquals(0, client.claims);
    clock.time += 9999;
    c.tick();
    assertEquals(0, client.claims);
    clock.time++;
    c.tick();
    assertEquals(1, transport.sends);
  }

  @Test
  public void gsmExtensionsCountTwiceAndUnicodeFailsClosed() {
    assertTrue(AndroidSmsTransport.singleGsmSegment("a".repeat(160)));
    assertFalse(AndroidSmsTransport.singleGsmSegment("a".repeat(161)));
    assertTrue(AndroidSmsTransport.singleGsmSegment("^".repeat(80)));
    assertFalse(AndroidSmsTransport.singleGsmSegment("^".repeat(81)));
    assertFalse(AndroidSmsTransport.singleGsmSegment("hello 🙂"));
    assertFalse(AndroidSmsTransport.singleGsmSegment(""));
  }

  @Test
  public void beginResponseAfterDispatchWindowDoesNotSend() {
    client.beginDelay = 60001;
    runEligible(coordinator());
    assertEquals(0, transport.sends);
    assertEquals("UNCERTAIN", journal.active().phase);
  }

  @Test
  public void reportingWhileStoppedRetriesSameOutcomeUntilExactAck() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    DispatchGate.stop();
    GatewayJournal.Outcome o = journal.outcome(attempt);
    client.loseAck = true;
    assertEquals(
        androidx.work.ListenableWorker.Result.retry(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertEquals(o.payload, journal.outcome(attempt).payload);
    assertNotNull(journal.active());
    assertEquals(
        androidx.work.ListenableWorker.Result.success(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertNull(journal.active());
    assertEquals(0, transport.sends);
    // An already queued duplicate worker must finish without another upload after ACK.
    assertEquals(
        androidx.work.ListenableWorker.Result.success(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertEquals(2, client.reports);
  }

  @Test
  public void reportConflictIsBlockedWithoutChangingPayload() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    client.reportError = "23514";
    assertEquals(
        androidx.work.ListenableWorker.Result.failure(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertEquals(o.payload, journal.outcome(attempt).payload);
    assertTrue(journal.outcome(attempt).blocked);
    assertNotNull(journal.active());
  }

  @Test
  public void authRepairUnblocksOnlyAuthorizationFailures() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    client.reportError = "P0001";
    OutcomeReportWorker.reportSaved(journal, client, o);
    assertTrue(journal.outcome(attempt).blocked);
    assertEquals(GatewayJournal.AUTH_ATTENTION, journal.attention());
    journal.repairedCredentials(profile);
    assertFalse(journal.outcome(attempt).blocked);
    assertEquals("", journal.attention());
    journal.block(o, "Conflict requires review");
    journal.repairedCredentials(profile);
    assertTrue(journal.outcome(attempt).blocked);
    assertFalse(journal.attention().isEmpty());
  }

  @Test
  public void preflightReportAfterExpiryRetiresOnlyWithServerProof() throws Exception {
    prepared();
    journal.preflightFailure(attempt, "one segment required");
    GatewayJournal.Outcome o = journal.outcome(attempt);
    client.reportError = "55000";
    client.server = "expired";
    assertEquals(
        androidx.work.ListenableWorker.Result.success(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertEquals(o.request, client.lastRequest);
    assertNull(journal.active());
    assertTrue(journal.outcome(attempt).blocked);
    assertEquals(o.payload, journal.outcome(attempt).payload);
  }

  @Test
  public void malformedWorkerAckBlocksAndRetainsOutcome() throws Exception {
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    client.wrongAck = true;
    assertEquals(
        androidx.work.ListenableWorker.Result.failure(),
        OutcomeReportWorker.reportSaved(journal, client, o));
    assertNotNull(journal.active());
    assertEquals(o.payload, journal.outcome(attempt).payload);
  }

  @Test
  public void receiptRejectsMissingTimestampOrWrongQueueOrOutcome() throws Exception {
    JSONObject missing = receipt("sending");
    missing.remove("outcome_due_at");
    assertThrows(Exception.class, () -> new RpcReceipt(missing));
    RpcReceipt other =
        new RpcReceipt(receipt("sending").put("queue_id", UUID.randomUUID().toString()));
    assertThrows(Exception.class, () -> other.matches(attempt, queue));
  }

  @Test
  public void claimClientRejectsWrongPayloadIdentityAndOldShape() throws Exception {
    String request = UUID.randomUUID().toString();
    JSONObject response = claimReceipt(request, "claimed");
    response.getJSONObject("message").put("id", UUID.randomUUID().toString());
    SupabaseGatewayClient rpc =
        new SupabaseGatewayClient(client.config) {
          @Override
          JSONObject rpc(String name, JSONObject parameters) {
            return response;
          }
        };
    assertThrows(Exception.class, () -> rpc.claim(request));
    response.remove("message");
    assertThrows(Exception.class, () -> rpc.claim(request));
  }

  @Test
  public void profileBindingAndImmutableSqlTriggerAreEnforced() throws Exception {
    assertThrows(
        Exception.class, () -> journal.profile(profile, "https://another.supabase.co", device));
    guarded();
    journal.callback(profile, attempt, Activity.RESULT_OK);
    assertThrows(
        Exception.class,
        () -> journal.getWritableDatabase().execSQL("UPDATE outcomes SET payload='{}'"));
  }

  @Test
  public void callbackCommitFailureCannotEraseAttempt() throws Exception {
    guarded();
    journal
        .getWritableDatabase()
        .execSQL(
            "CREATE TRIGGER fail_callback BEFORE INSERT ON outcomes BEGIN SELECT RAISE(ABORT,'disk"
                + " full'); END");
    assertThrows(Exception.class, () -> journal.callback(profile, attempt, Activity.RESULT_OK));
    assertNotNull(journal.active());
    assertNull(journal.outcome(attempt));
    journal.getWritableDatabase().execSQL("DROP TRIGGER fail_callback");
    journal.callback(profile, attempt, Activity.RESULT_OK);
    assertNotNull(journal.outcome(attempt));
  }

  @Test
  public void remoteTerminalWithoutLocalCallbackNeverSends() throws Exception {
    prepared();
    client.server = "sent";
    runEligible(coordinator());
    assertNull(journal.active());
    assertEquals(0, transport.sends);
    assertEquals(0, client.begins);
  }

  @Test
  public void fullPacingIsPreservedAfterFastCallbackAndAck() throws Exception {
    GatewayCoordinator c = coordinator();
    runEligible(c);
    journal.callback(profile, attempt, Activity.RESULT_OK);
    GatewayJournal.Outcome o = journal.outcome(attempt);
    journal.acknowledge(o, client.report(o.kind, o.payload));
    attempt = UUID.randomUUID().toString();
    queue = UUID.randomUUID().toString();
    client.server = "claimed";
    clock.time += 5000;
    c.tick();
    assertEquals(1, transport.sends);
    clock.time += 4999;
    c.tick();
    assertEquals(1, transport.sends);
    clock.time++;
    c.tick();
    assertEquals(2, transport.sends);
  }
}
