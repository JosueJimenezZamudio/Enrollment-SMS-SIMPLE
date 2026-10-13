package com.enrollmentdesk.enrollmentsms;

import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.UUID;
import org.json.JSONObject;

/** Strict protocol boundary: a malformed 2xx response is never authorization or acknowledgment. */
final class RpcReceipt {
  final JSONObject json;
  final String state, attemptId, queueId;

  RpcReceipt(JSONObject value) throws Exception {
    json = value;
    state = value.getString("state");
    if (!Arrays.asList("claimed", "sending", "unknown", "sent", "failed", "expired", "cancelled")
        .contains(state)) throw new IllegalArgumentException("Unknown attempt state");
    attemptId = uuid(value, "attempt_id");
    queueId = uuid(value, "queue_id");
    timestamp(value, "claim_expires_at", true);
    timestamp(value, "send_authorized_at", state.equals("sending") || state.equals("unknown"));
    timestamp(value, "outcome_due_at", state.equals("sending") || state.equals("unknown"));
    timestamp(value, "completed_at", terminal());
    if (!value.has("outcome_event_id"))
      throw new IllegalArgumentException("Missing outcome identity");
    if (terminal()) uuid(value, "outcome_event_id");
  }

  boolean terminal() {
    return state.equals("sent") || state.equals("failed");
  }

  void matches(String attempt, String queue) {
    if (!attemptId.equals(attempt) || !queueId.equals(queue))
      throw new IllegalArgumentException("Receipt identity mismatch");
  }

  void acknowledge(JSONObject payload, String kind) throws Exception {
    matches(payload.getString("p_attempt_id"), payload.getString("p_queue_id"));
    if (!state.equals(kind)
        || !uuid(json, "outcome_event_id").equals(payload.getString("p_outcome_event_id")))
      throw new IllegalArgumentException("Outcome acknowledgment mismatch");
    timestamp(json, "completed_at", true);
  }

  static String uuid(JSONObject object, String key) throws Exception {
    String s = object.getString(key);
    if (!UUID.fromString(s).toString().equals(s))
      throw new IllegalArgumentException("Invalid UUID");
    return s;
  }

  static void timestamp(JSONObject o, String key, boolean required) throws Exception {
    if (!o.has(key) || (required && o.isNull(key)))
      throw new IllegalArgumentException("Missing receipt timestamp");
    if (!o.isNull(key)) OffsetDateTime.parse(o.getString(key));
  }
}
