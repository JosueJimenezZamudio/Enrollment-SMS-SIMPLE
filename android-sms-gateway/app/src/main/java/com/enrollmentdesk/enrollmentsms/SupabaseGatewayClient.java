package com.enrollmentdesk.enrollmentsms;

import android.os.Build;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

class SupabaseGatewayClient {
  static final String APP_VERSION = "2.0.0";
  final GatewayConfig config;

  SupabaseGatewayClient(GatewayConfig config) {
    this.config = config;
  }

  static final class RpcError extends IOException {
    final String code;
    final int status;
    final boolean retryable;
    final long retryAfterMs;

    RpcError(int status, String code, long retryAfterMs) {
      super("RPC HTTP " + status + " / " + code);
      this.status = status;
      this.code = code;
      this.retryable = status == 429 || status >= 500;
      this.retryAfterMs = retryAfterMs;
    }
  }

  static boolean authorizationError(RpcError e) {
    return e.status == 401 || e.status == 403 || e.code.equals("P0001") || e.code.equals("42501");
  }

  String heartbeat() throws Exception {
    JSONObject result =
        rpc(
            "device_heartbeat",
            new JSONObject()
                .put("p_app_version", APP_VERSION)
                .put("p_android_version", String.valueOf(Build.VERSION.SDK_INT))
                .put("p_manufacturer", Build.MANUFACTURER)
                .put("p_model", Build.MODEL)
                .put("p_metadata", new JSONObject()));
    return RpcReceipt.uuid(result, "id");
  }

  JSONObject claim(String requestId) throws Exception {
    JSONObject result =
        rpc("device_claim_sms_queue", new JSONObject().put("p_claim_request_id", requestId));
    if (!RpcReceipt.uuid(result, "claim_request_id").equals(requestId))
      throw new IllegalArgumentException("Claim identity mismatch");
    String kind = result.getString("result");
    if (kind.equals("empty") || kind.equals("busy")) {
      if (!result.has("attempt_id")) throw new IllegalArgumentException("Missing claim identity");
      if (!result.isNull("attempt_id")) RpcReceipt.uuid(result, "attempt_id");
      if (kind.equals("empty") && !result.isNull("attempt_id"))
        throw new IllegalArgumentException("Invalid empty claim");
    } else {
      RpcReceipt receipt = new RpcReceipt(result);
      if (!kind.equals(receipt.state)) throw new IllegalArgumentException("Claim state mismatch");
      if (kind.equals("claimed")) {
        JSONObject message = result.getJSONObject("message");
        if (!RpcReceipt.uuid(message, "id").equals(receipt.queueId)
            || message.getString("body").isEmpty()
            || message.getString("to_phone").isEmpty())
          throw new IllegalArgumentException("Invalid claim payload");
        message.getJSONObject("metadata");
      } else if (!result.has("message") || !result.isNull("message"))
        throw new IllegalArgumentException("Unexpected claim payload");
    }
    return result;
  }

  RpcReceipt begin(String attemptId) throws Exception {
    return new RpcReceipt(
        rpc("device_begin_sms_attempt", new JSONObject().put("p_attempt_id", attemptId)));
  }

  RpcReceipt report(String kind, String frozenPayload) throws Exception {
    JSONObject payload = new JSONObject(frozenPayload);
    RpcReceipt receipt = new RpcReceipt(rpc("device_mark_sms_" + kind, payload));
    receipt.acknowledge(payload, kind);
    return receipt;
  }

  JSONObject rpc(String name, JSONObject parameters) throws Exception {
    if (!config.isReady()) throw new IllegalArgumentException("Invalid configuration");
    JSONObject body =
        new JSONObject(parameters.toString()).put("p_device_token", config.deviceToken);
    HttpURLConnection c =
        (HttpURLConnection) new URL(config.supabaseUrl + "/rest/v1/rpc/" + name).openConnection();
    try {
      c.setInstanceFollowRedirects(false);
      c.setRequestMethod("POST");
      c.setConnectTimeout(15000);
      c.setReadTimeout(15000);
      c.setDoOutput(true);
      c.setRequestProperty("apikey", config.apiKey);
      c.setRequestProperty("Content-Type", "application/json");
      c.setRequestProperty("Accept", "application/json");
      byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
      c.setFixedLengthStreamingMode(bytes.length);
      try (OutputStream stream = c.getOutputStream()) {
        stream.write(bytes);
      }
      int status = c.getResponseCode();
      String response =
          read(
              c.getResponseCode() >= 200 && status < 300 ? c.getInputStream() : c.getErrorStream());
      if (status < 200 || status >= 300) {
        String code = "HTTP";
        try {
          code = new JSONObject(response).optString("code", "HTTP");
        } catch (Exception ignored) {
        }
        // Never display backend message/details, which can contain contact data.
        if (!code.matches("[A-Za-z0-9_]{1,32}")) code = "HTTP";
        long delay = 0;
        try {
          delay =
              Math.min(86400, Math.max(0, Long.parseLong(c.getHeaderField("Retry-After")))) * 1000L;
        } catch (Exception ignored) {
        }
        throw new RpcError(status, code, delay);
      }
      return new JSONObject(response);
    } finally {
      c.disconnect();
    }
  }

  private static String read(InputStream stream) throws IOException {
    if (stream == null) return "";
    try (InputStream in = stream;
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] b = new byte[4096];
      int n;
      while ((n = in.read(b)) != -1) {
        if (out.size() + n > 131072) throw new IOException("RPC response too large");
        out.write(b, 0, n);
      }
      return out.toString("UTF-8");
    }
  }
}
