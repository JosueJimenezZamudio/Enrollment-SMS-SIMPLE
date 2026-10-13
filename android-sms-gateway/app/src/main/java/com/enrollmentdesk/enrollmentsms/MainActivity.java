package com.enrollmentdesk.enrollmentsms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.*;
import android.text.InputType;
import android.widget.*;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
  private EditText url, key, token, poll;
  private TextView status;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private String connectionStatus = "";
  private final Runnable refresh =
      new Runnable() {
        public void run() {
          showStatus();
          main.postDelayed(this, 1000);
        }
      };

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(32, 32, 32, 32);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(root);
    setContentView(scroll);
    TextView title = new TextView(this);
    title.setText("Enrollment SMS Gateway · Phase 2");
    title.setTextSize(23);
    root.addView(title);
    TextView help = new TextView(this);
    help.setText(
        "A new process never resumes sending automatically. Save and verify a profile, then"
            + " explicitly start a session (maximum one hour). Saved outcomes can upload while"
            + " sending is stopped.");
    root.addView(help);
    url = field(root, "HTTPS Supabase URL", false);
    key = field(root, "Publishable / anon API key", true);
    token = field(root, "Device token", true);
    poll = field(root, "Poll seconds (5–60)", false);
    poll.setInputType(InputType.TYPE_CLASS_NUMBER);
    GatewayConfig config = GatewayConfig.load(this);
    url.setText(config.supabaseUrl);
    key.setText(config.apiKey);
    token.setText(config.deviceToken);
    poll.setText(String.valueOf(config.pollSeconds));
    button(root, "Test connection (does not save or start)", () -> verify(false));
    button(root, "Save and verify profile (keeps sending stopped)", () -> verify(true));
    button(root, "Start one-hour gateway session", this::startSession);
    button(root, "Stop sending; retain and report outcomes", this::stopSession);
    status = new TextView(this);
    root.addView(status);
  }

  private EditText field(LinearLayout root, String hint, boolean secret) {
    EditText e = new EditText(this);
    e.setHint(hint);
    e.setSingleLine(true);
    if (secret) e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
    root.addView(e);
    return e;
  }

  private void button(LinearLayout root, String name, Runnable action) {
    Button b = new Button(this);
    b.setText(name);
    b.setOnClickListener(v -> action.run());
    root.addView(b);
  }

  private GatewayConfig candidate() {
    int seconds = 5;
    try {
      seconds = Integer.parseInt(poll.getText().toString());
    } catch (Exception ignored) {
    }
    return new GatewayConfig(
        url.getText().toString(),
        key.getText().toString(),
        token.getText().toString(),
        seconds,
        "",
        "");
  }

  private void verify(boolean save) {
    GatewayConfig c = candidate();
    if (!c.isReady()) {
      connectionStatus = "Use an HTTPS project URL, public API key and device token.";
      showStatus();
      return;
    }
    if (save && DispatchGate.running()) {
      connectionStatus = "Stop the session before editing configuration.";
      showStatus();
      return;
    }
    connectionStatus = "Testing connection…";
    io.execute(
        () -> {
          try {
            String device = new SupabaseGatewayClient(c).heartbeat();
            if (save) {
              GatewayConfig.saveVerified(this, c, device);
              OutcomeReportWorker.schedulePending(this);
            }
            runOnUiThread(
                () -> {
                  connectionStatus =
                      save
                          ? "Verified profile saved. Sending remains stopped."
                          : "Heartbeat succeeded. Configuration unchanged.";
                  showStatus();
                });
          } catch (Exception e) {
            runOnUiThread(
                () -> {
                  connectionStatus =
                      "Connection/save failed. Check credentials, identity and pending work.";
                  showStatus();
                });
          }
        });
  }

  private void startSession() {
    if (DispatchGate.running()) return;
    try {
      if (GatewayApplication.storageFailed) throw new IllegalStateException();
      GatewayConfig c = GatewayConfig.load(this);
      GatewayJournal j = GatewayJournal.get(this);
      j.requireProfile(c);
      if (!c.isReady() || !j.attention().isEmpty()) throw new IllegalStateException();
      ArrayList<String> needed = new ArrayList<>();
      if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED)
        needed.add(Manifest.permission.SEND_SMS);
      if (Build.VERSION.SDK_INT >= 33
          && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
              != PackageManager.PERMISSION_GRANTED)
        needed.add(Manifest.permission.POST_NOTIFICATIONS);
      if (!needed.isEmpty()) {
        requestPermissions(needed.toArray(new String[0]), 7001);
        connectionStatus = "After granting permissions, press Start again.";
        return;
      }
      DispatchGate.start();
      startForegroundService(new Intent(this, SmsGatewayService.class));
      connectionStatus = "";
    } catch (Exception e) {
      DispatchGate.stop();
      connectionStatus =
          "Cannot start: verify configuration, journal health and Android service availability.";
    }
    showStatus();
  }

  private void stopSession() {
    DispatchGate.stop();
    stopService(new Intent(this, SmsGatewayService.class));
    try {
      GatewayJournal.get(this).status("Stopped; saved work retained");
      OutcomeReportWorker.schedulePending(this);
    } catch (Exception e) {
      GatewayApplication.storageFailed = true;
    }
    connectionStatus = "Sending stopped. An already submitted SMS cannot be recalled.";
    showStatus();
  }

  private void showStatus() {
    if (status == null) return;
    try {
      GatewayJournal j = GatewayJournal.get(this);
      GatewayJournal.Slot slot = j.active();
      status.setText(
          (GatewayApplication.storageFailed ? "Storage failure; sending stopped" : j.status())
              + "\nSession: "
              + (DispatchGate.running() ? "active" : "stopped")
              + "\nPending reports: "
              + j.pending().size()
              + (slot == null
                  ? ""
                  : "\nLocal state: "
                      + slot.phase
                      + "\nAttempt: "
                      + (slot.attempt == null ? "claim pending" : slot.attempt))
              + "\n"
              + connectionStatus);
    } catch (Exception e) {
      status.setText("Journal unavailable; sending stopped. Do not clear application data.");
      DispatchGate.stop();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    main.post(refresh);
  }

  @Override
  protected void onPause() {
    main.removeCallbacks(refresh);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    io.shutdownNow();
    super.onDestroy();
  }
}
