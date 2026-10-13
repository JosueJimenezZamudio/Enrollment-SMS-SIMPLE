package com.enrollmentdesk.enrollmentsms;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.app.Application;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Opt-in HTTPS contract test. Never constructs a coordinator, service, or SMS transport. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, application = Application.class)
public class LiveRpcContractTest {
  @Test
  public void liveDedicatedProjectContractWithoutSmsTransport() throws Exception {
    String file = System.getProperty("liveRpcConfig", "");
    assumeTrue("Live RPC fixture configuration not supplied", !file.isEmpty());
    JSONObject fixture =
        new JSONObject(
            new String(Files.readAllBytes(Path.of(file)), java.nio.charset.StandardCharsets.UTF_8));
    assertEquals("https://rccdxrmyavihzdrgokpv.supabase.co", fixture.getString("url"));
    assertTrue(
        "Requires isolated disposable fixtures", fixture.getBoolean("disposable_no_sms_fixture"));
    SupabaseGatewayClient owner = client(fixture, "owner");
    SupabaseGatewayClient other = client(fixture, "other");
    assertEquals(fixture.getString("owner_id"), owner.heartbeat());
    assertEquals(fixture.getString("other_id"), other.heartbeat());

    if (fixture.has("expired_request_id")) {
      JSONObject expired = owner.claim(fixture.getString("expired_request_id"));
      assertEquals("expired", expired.getString("state"));
      assertEquals(fixture.getString("expired_attempt_id"), expired.getString("attempt_id"));
      assertTrue(expired.isNull("message"));
    }
    String request = UUID.randomUUID().toString();
    JSONObject claim = owner.claim(request);
    assertEquals("claimed", claim.getString("state"));
    assertEquals(fixture.getString("sent_queue_id"), claim.getString("queue_id"));
    assertEquals("NO_SMS_CONTRACT_FIXTURE", claim.getJSONObject("message").getString("to_phone"));
    RpcReceipt reserved = new RpcReceipt(claim);
    assertEquals(reserved.attemptId, owner.claim(request).getString("attempt_id"));
    JSONObject busy = owner.claim(UUID.randomUUID().toString());
    assertEquals("busy", busy.getString("result"));
    assertEquals(reserved.attemptId, busy.getString("attempt_id"));

    SupabaseGatewayClient.RpcError wrongOwner =
        assertThrows(SupabaseGatewayClient.RpcError.class, () -> other.begin(reserved.attemptId));
    assertTrue("Wrong device must be denied", SupabaseGatewayClient.authorizationError(wrongOwner));
    RpcReceipt begun = owner.begin(reserved.attemptId);
    assertEquals("sending", begun.state);
    RpcReceipt repeatedBegin = owner.begin(reserved.attemptId);
    assertEquals(
        begun.json.getString("send_authorized_at"),
        repeatedBegin.json.getString("send_authorized_at"));
    assertEquals(
        begun.json.getString("outcome_due_at"), repeatedBegin.json.getString("outcome_due_at"));

    // A synthetic database outcome only. No modem, SmsManager or gateway session is involved.
    JSONObject sent =
        payload(fixture, reserved)
            .put("p_sms_message_id", "contract-fixture:" + reserved.attemptId);
    String frozen = sent.toString();
    RpcReceipt ack = owner.report("sent", frozen);
    RpcReceipt repeat = owner.report("sent", frozen);
    assertEquals(ack.json.getString("completed_at"), repeat.json.getString("completed_at"));
    assertEquals(ack.json.getString("outcome_event_id"), repeat.json.getString("outcome_event_id"));
    assertEquals("sent", owner.claim(request).getString("state"));
    SupabaseGatewayClient.RpcError wrongReport =
        assertThrows(SupabaseGatewayClient.RpcError.class, () -> other.report("sent", frozen));
    assertTrue(
        "Wrong-device report must be denied",
        SupabaseGatewayClient.authorizationError(wrongReport));
    JSONObject changed = new JSONObject(frozen).put("p_sms_message_id", "conflicting-fixture-id");
    SupabaseGatewayClient.RpcError conflict =
        assertThrows(
            SupabaseGatewayClient.RpcError.class, () -> owner.report("sent", changed.toString()));
    assertEquals("23514", conflict.code);

    JSONObject rejected = owner.claim(UUID.randomUUID().toString());
    assertEquals(fixture.getString("failed_queue_id"), rejected.getString("queue_id"));
    RpcReceipt second = new RpcReceipt(rejected);
    String failure =
        payload(fixture, second).put("p_error", "Synthetic no-send preflight rejection").toString();
    RpcReceipt failed = owner.report("failed", failure);
    assertEquals("failed", failed.state);
    assertEquals(
        failed.json.getString("completed_at"),
        owner.report("failed", failure).json.getString("completed_at"));
    String emptyRequest = UUID.randomUUID().toString();
    assertEquals("empty", owner.claim(emptyRequest).getString("result"));
    assertEquals("empty", owner.claim(emptyRequest).getString("result"));

    SupabaseGatewayClient invalid =
        new SupabaseGatewayClient(
            new GatewayConfig(
                fixture.getString("url"),
                fixture.getString("publishable_key"),
                "invalid-contract-fixture-token",
                5,
                "",
                ""));
    assertEquals(
        "P0001", assertThrows(SupabaseGatewayClient.RpcError.class, invalid::heartbeat).code);
  }

  private static SupabaseGatewayClient client(JSONObject f, String name) throws Exception {
    return new SupabaseGatewayClient(
        new GatewayConfig(
            f.getString("url"),
            f.getString("publishable_key"),
            f.getString(name + "_token"),
            5,
            UUID.randomUUID().toString(),
            f.getString(name + "_id")));
  }

  private static JSONObject payload(JSONObject fixture, RpcReceipt receipt) throws Exception {
    return new JSONObject()
        .put("p_queue_id", receipt.queueId)
        .put("p_attempt_id", receipt.attemptId)
        .put("p_outcome_event_id", UUID.randomUUID().toString())
        .put(
            "p_metadata",
            new JSONObject()
                .put("contract_fixture", fixture.getString("run_id"))
                .put("transport_invoked", false));
  }
}
