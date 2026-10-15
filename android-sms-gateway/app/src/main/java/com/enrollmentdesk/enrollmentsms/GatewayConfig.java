package com.enrollmentdesk.enrollmentsms;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.net.URI;
import java.util.UUID;
import org.json.JSONObject;

final class GatewayConfig {
  static final int MIN_POLL_SECONDS = 5, MAX_POLL_SECONDS = 60, DEFAULT_POLL_SECONDS = 5;
  static final String PREFS = "enrollment_sms_gateway";
  final String supabaseUrl, apiKey, deviceToken, profileId, deviceId;
  final int pollSeconds;

  GatewayConfig(String url, String key, String token, int poll, String profile, String device) {
    supabaseUrl = url.trim().replaceAll("/+$", "");
    apiKey = key.trim();
    deviceToken = token.trim();
    pollSeconds = Math.max(5, Math.min(60, poll));
    profileId = profile;
    deviceId = device;
  }

  static GatewayConfig load(Context c) {
    SharedPreferences p = c.getSharedPreferences(PREFS, 0);
    return new GatewayConfig(
        p.getString("supabase_url", ""),
        p.getString("api_key", ""),
        p.getString("device_token", ""),
        p.getInt("poll_seconds", 5),
        p.getString("profile_id", ""),
        p.getString("device_id", ""));
  }

  boolean isReady() {
    try {
      URI uri = new URI(supabaseUrl);
      if (!"https".equals(uri.getScheme())
          || uri.getHost() == null
          || uri.getUserInfo() != null
          || uri.getQuery() != null
          || uri.getFragment() != null
          || !uri.getPath().isEmpty()) return false;
      boolean publicKey = apiKey.startsWith("sb_publishable_");
      if (!publicKey && apiKey.split("\\.").length == 3) {
        JSONObject jwt =
            new JSONObject(
                new String(
                    Base64.decode(apiKey.split("\\.")[1], Base64.URL_SAFE),
                    java.nio.charset.StandardCharsets.UTF_8));
        publicKey = "anon".equals(jwt.optString("role"));
      }
      return publicKey && !deviceToken.isEmpty();
    } catch (Exception e) {
      return false;
    }
  }

  /** Must be called with a successful heartbeat identity, while the session is stopped. */
  static void saveVerified(Context c, GatewayConfig candidate, String device) throws Exception {
    synchronized (DispatchGate.LOCK) {
      if (DispatchGate.running() || GatewayLifecycle.enabled(c))
        throw new IllegalStateException("Stop the session before editing configuration");
      GatewayJournal j = GatewayJournal.get(c);
      GatewayConfig old = load(c);
      if (!candidate.isReady())
        throw new IllegalArgumentException("HTTPS URL and public API key required");
      boolean same =
          old.supabaseUrl.equals(candidate.supabaseUrl)
              && old.deviceId.equals(device)
              && !old.profileId.isEmpty();
      if (j.active() != null && !same)
        throw new IllegalStateException("Unresolved work binds this project and device");
      String profile = same ? old.profileId : UUID.randomUUID().toString();
      j.profile(profile, candidate.supabaseUrl, device);
      if (!c.getSharedPreferences(PREFS, 0)
          .edit()
          .putString("supabase_url", candidate.supabaseUrl)
          .putString("api_key", candidate.apiKey)
          .putString("device_token", candidate.deviceToken)
          .putInt("poll_seconds", candidate.pollSeconds)
          .putString("profile_id", profile)
          .putString("device_id", device)
          .putBoolean("enabled", false)
          .commit()) throw new IllegalStateException("Configuration could not be saved");
      if (same) j.repairedCredentials(profile);
    }
  }

  static void initialize(Context c) throws Exception {
    SharedPreferences p = c.getSharedPreferences(PREFS, 0);
    boolean missing =
        !p.getString("profile_id", "").isEmpty()
            && !c.getDatabasePath("gateway-journal.db").exists();
    // Upgrade requires one explicit production start; subsequent process launches preserve intent.
    if (!p.getBoolean("continuous_initialized", false)
        && !p.edit()
            .putBoolean("enabled", false)
            .putBoolean("continuous_initialized", true)
            .commit()) throw new IllegalStateException("Storage unavailable");
    GatewayJournal j = GatewayJournal.get(c);
    if (missing) j.attention("Journal missing; backend reconciliation required");
    if (!c.getSharedPreferences("pending_sends", 0).getAll().isEmpty())
      j.attention("Legacy pending sends quarantined; operator reconciliation required");
  }
}
