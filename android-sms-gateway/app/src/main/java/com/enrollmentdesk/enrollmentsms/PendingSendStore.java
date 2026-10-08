package com.enrollmentdesk.enrollmentsms;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

final class PendingSendStore {
    private static final String PREFS = "pending_sends";

    static void put(Context context, int requestCode, OutboxMessage message) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("id", message.id);
            obj.put("phone", message.phone);
            obj.put("body", message.body);
            obj.put("metadata", message.metadata);
        } catch (JSONException ignored) {
            return;
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(String.valueOf(requestCode), obj.toString())
                .apply();
    }

    static OutboxMessage pop(Context context, int requestCode) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = String.valueOf(requestCode);
        String raw = prefs.getString(key, null);
        prefs.edit().remove(key).apply();
        if (raw == null) return null;
        try {
            JSONObject obj = new JSONObject(raw);
            return new OutboxMessage(
                    obj.optString("id", ""),
                    obj.optString("phone", ""),
                    obj.optString("body", ""),
                    obj.optJSONObject("metadata")
            );
        } catch (JSONException ignored) {
            return null;
        }
    }
}
