package com.enrollmentdesk.enrollmentsms;

import android.content.Context;
import android.content.SharedPreferences;

final class GatewayConfig {
    static final int MIN_POLL_SECONDS = 5;
    static final int MAX_POLL_SECONDS = 60;
    static final int DEFAULT_POLL_SECONDS = 5;
    static final String PREFS = "enrollment_sms_gateway";
    static final String KEY_SUPABASE_URL = "supabase_url";
    static final String KEY_API_KEY = "api_key";
    static final String KEY_DEVICE_TOKEN = "device_token";
    static final String KEY_POLL_SECONDS = "poll_seconds";
    static final String KEY_ENABLED = "enabled";

    final String supabaseUrl;
    final String apiKey;
    final String deviceToken;
    final int pollSeconds;
    final boolean enabled;

    private GatewayConfig(String supabaseUrl, String apiKey, String deviceToken, int pollSeconds, boolean enabled) {
        this.supabaseUrl = cleanBaseUrl(supabaseUrl);
        this.apiKey = cleanToken(apiKey);
        this.deviceToken = cleanToken(deviceToken);
        this.pollSeconds = clampPollSeconds(pollSeconds);
        this.enabled = enabled;
    }

    static GatewayConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new GatewayConfig(
                prefs.getString(KEY_SUPABASE_URL, ""),
                prefs.getString(KEY_API_KEY, ""),
                prefs.getString(KEY_DEVICE_TOKEN, ""),
                prefs.getInt(KEY_POLL_SECONDS, DEFAULT_POLL_SECONDS),
                prefs.getBoolean(KEY_ENABLED, false)
        );
    }

    static void save(Context context, String supabaseUrl, String apiKey, String deviceToken, int pollSeconds, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_SUPABASE_URL, cleanBaseUrl(supabaseUrl))
                .putString(KEY_API_KEY, cleanToken(apiKey))
                .putString(KEY_DEVICE_TOKEN, cleanToken(deviceToken))
                .putInt(KEY_POLL_SECONDS, clampPollSeconds(pollSeconds))
                .putBoolean(KEY_ENABLED, enabled)
                .apply();
    }

    boolean isReady() {
        return !supabaseUrl.isEmpty() && !apiKey.isEmpty() && !deviceToken.isEmpty();
    }

    private static String cleanBaseUrl(String value) {
        String clean = cleanToken(value);
        while (clean.endsWith("/")) clean = clean.substring(0, clean.length() - 1);
        return clean;
    }

    private static String cleanToken(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "");
    }

    private static int clampPollSeconds(int value) {
        return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, value));
    }
}
