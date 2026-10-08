package com.enrollmentdesk.enrollmentsms;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

final class SupabaseGatewayClient {
    static final String APP_VERSION = "1.0.0";

    private final GatewayConfig config;

    SupabaseGatewayClient(GatewayConfig config) {
        this.config = config;
    }

    void heartbeat() throws IOException, JSONException {
        JSONObject body = withDeviceToken()
                .put("p_app_version", APP_VERSION)
                .put("p_android_version", String.valueOf(Build.VERSION.SDK_INT))
                .put("p_manufacturer", Build.MANUFACTURER)
                .put("p_model", Build.MODEL)
                .put("p_metadata", new JSONObject());
        postRpcObject("device_heartbeat", body);
    }

    List<OutboxMessage> claimQueue(int limit) throws IOException, JSONException {
        JSONArray rows = postRpcArray(
                "device_claim_sms_queue",
                withDeviceToken().put("p_limit", limit)
        );
        List<OutboxMessage> messages = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            messages.add(new OutboxMessage(
                    row.optString("id"),
                    row.optString("to_phone"),
                    row.optString("body"),
                    row.optJSONObject("metadata")
            ));
        }
        return messages;
    }

    void markSent(String queueId, String smsMessageId, JSONObject metadata) throws IOException, JSONException {
        JSONObject report = copyMetadata(metadata)
                .put("app_version", APP_VERSION)
                .put("android_sdk", Build.VERSION.SDK_INT)
                .put("reported_at", Instant.now().toString());
        postRpcObject(
                "device_mark_sms_sent",
                withDeviceToken()
                        .put("p_queue_id", queueId)
                        .put("p_sms_message_id", smsMessageId)
                        .put("p_metadata", report)
        );
    }

    void markFailed(String queueId, String error, JSONObject metadata) throws IOException, JSONException {
        JSONObject report = copyMetadata(metadata)
                .put("app_version", APP_VERSION)
                .put("android_sdk", Build.VERSION.SDK_INT)
                .put("reported_at", Instant.now().toString());
        postRpcObject(
                "device_mark_sms_failed",
                withDeviceToken()
                        .put("p_queue_id", queueId)
                        .put("p_error", error)
                        .put("p_metadata", report)
        );
    }

    private JSONObject copyMetadata(JSONObject source) throws JSONException {
        JSONObject copy = new JSONObject();
        if (source == null) return copy;
        JSONArray names = source.names();
        if (names == null) return copy;
        for (int i = 0; i < names.length(); i++) {
            String name = names.getString(i);
            copy.put(name, source.opt(name));
        }
        return copy;
    }

    private JSONObject withDeviceToken() throws JSONException {
        return new JSONObject().put("p_device_token", config.deviceToken);
    }

    private JSONObject postRpcObject(String functionName, JSONObject body) throws IOException, JSONException {
        String response = postRpc(functionName, body);
        if (response == null || response.trim().isEmpty() || "null".equals(response.trim())) return new JSONObject();
        return new JSONObject(response);
    }

    private JSONArray postRpcArray(String functionName, JSONObject body) throws IOException {
        String response = postRpc(functionName, body);
        if (response == null || response.trim().isEmpty()) return new JSONArray();
        try {
            return new JSONArray(response);
        } catch (JSONException error) {
            throw new IOException("Invalid JSON from Supabase: " + response, error);
        }
    }

    private String postRpc(String functionName, JSONObject body) throws IOException {
        if (!config.isReady()) throw new IOException("Missing Supabase configuration.");

        URL url = new URL(config.supabaseUrl + "/rest/v1/rpc/" + functionName);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setDoOutput(true);
        connection.setRequestProperty("apikey", config.apiKey);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");

        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }

        int status = connection.getResponseCode();
        String response = readAll(status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream());
        connection.disconnect();

        if (status < 200 || status >= 300) {
            throw new IOException("Supabase RPC failed (" + status + "): " + response);
        }
        return response;
    }

    private static String readAll(InputStream input) throws IOException {
        if (input == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }
}
