package com.enrollmentdesk.enrollmentsms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 7001;

    private EditText supabaseUrlInput;
    private EditText apiKeyInput;
    private EditText deviceTokenInput;
    private EditText pollSecondsInput;
    private Switch enabledSwitch;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        loadConfig();
        requestPermissionsIfNeeded();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(22), dp(22), dp(22));
        root.setBackgroundColor(Color.rgb(17, 20, 24));
        scroll.addView(root);

        root.addView(text("Enrollment SMS Gateway", 28, true));
        TextView subtitle = text("Dedicated outbound sender for the enrollment lead automation.", 15, false);
        subtitle.setTextColor(Color.rgb(190, 198, 207));
        subtitle.setPadding(0, dp(4), 0, dp(20));
        root.addView(subtitle);

        supabaseUrlInput = input("Supabase URL", false);
        apiKeyInput = input("Supabase publishable / anon key", true);
        deviceTokenInput = input("Device token", true);
        pollSecondsInput = input("Poll seconds", false);
        pollSecondsInput.setInputType(InputType.TYPE_CLASS_NUMBER);

        root.addView(label("Supabase URL"));
        root.addView(supabaseUrlInput);
        root.addView(label("API Key"));
        root.addView(apiKeyInput);
        root.addView(label("Device Token"));
        root.addView(deviceTokenInput);
        root.addView(label("Poll Interval"));
        root.addView(pollSecondsInput);

        enabledSwitch = new Switch(this);
        enabledSwitch.setText("Gateway enabled");
        enabledSwitch.setTextColor(Color.WHITE);
        enabledSwitch.setTextSize(17);
        enabledSwitch.setPadding(0, dp(18), 0, dp(10));
        root.addView(enabledSwitch);

        Button saveButton = button("Save");
        Button testButton = button("Test Connection");
        root.addView(saveButton);
        root.addView(testButton);

        statusText = text("Not running", 15, false);
        statusText.setTextColor(Color.rgb(190, 198, 207));
        statusText.setPadding(0, dp(18), 0, 0);
        root.addView(statusText);

        saveButton.setOnClickListener(v -> saveAndApply());
        testButton.setOnClickListener(v -> testConnection());
        enabledSwitch.setOnCheckedChangeListener(this::onEnabledChanged);

        setContentView(scroll);
    }

    private void loadConfig() {
        GatewayConfig config = GatewayConfig.load(this);
        supabaseUrlInput.setText(config.supabaseUrl);
        apiKeyInput.setText(config.apiKey);
        deviceTokenInput.setText(config.deviceToken);
        pollSecondsInput.setText(String.valueOf(config.pollSeconds));
        enabledSwitch.setChecked(config.enabled);
        updateStatus(config);
    }

    private void saveAndApply() {
        GatewayConfig.save(
                this,
                supabaseUrlInput.getText().toString(),
                apiKeyInput.getText().toString(),
                deviceTokenInput.getText().toString(),
                parsePollSeconds(),
                enabledSwitch.isChecked()
        );

        GatewayConfig config = GatewayConfig.load(this);
        if (config.enabled && !config.isReady()) {
            GatewayConfig.save(this, config.supabaseUrl, config.apiKey, config.deviceToken, config.pollSeconds, false);
            enabledSwitch.setChecked(false);
            Toast.makeText(this, "Add the Supabase URL, API key, and device token first.", Toast.LENGTH_LONG).show();
            return;
        }

        applyServiceState(config);
        updateStatus(config);
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
    }

    private void onEnabledChanged(CompoundButton buttonView, boolean isChecked) {
        GatewayConfig config = GatewayConfig.load(this);
        if (config.enabled == isChecked) return;
        saveAndApply();
    }

    private void applyServiceState(GatewayConfig config) {
        Intent intent = new Intent(this, SmsGatewayService.class);
        if (config.enabled && config.isReady()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
            else startService(intent);
        } else {
            stopService(intent);
        }
    }

    private void testConnection() {
        saveAndApply();
        GatewayConfig config = GatewayConfig.load(this);
        if (!config.isReady()) return;

        statusText.setText("Testing Supabase...");
        new Thread(() -> {
            try {
                new SupabaseGatewayClient(config).heartbeat();
                runOnUiThread(() -> {
                    statusText.setText("Connected. Heartbeat succeeded.");
                    Toast.makeText(this, "Supabase connection works.", Toast.LENGTH_SHORT).show();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    statusText.setText("Connection failed: " + error.getMessage());
                    Toast.makeText(this, "Connection failed.", Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void updateStatus(GatewayConfig config) {
        statusText.setText(config.enabled && config.isReady()
                ? "Gateway running. Polling every " + config.pollSeconds + " seconds."
                : "Gateway stopped.");
    }

    private int parsePollSeconds() {
        try {
            return Math.min(
                    GatewayConfig.MAX_POLL_SECONDS,
                    Math.max(GatewayConfig.MIN_POLL_SECONDS, Integer.parseInt(pollSecondsInput.getText().toString().trim()))
            );
        } catch (Exception ignored) {
            return GatewayConfig.DEFAULT_POLL_SECONDS;
        }
    }

    private void requestPermissionsIfNeeded() {
        List<String> needed = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.SEND_SMS);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!needed.isEmpty()) requestPermissions(needed.toArray(new String[0]), PERMISSION_REQUEST);
    }

    private TextView label(String value) {
        TextView label = text(value, 13, true);
        label.setTextColor(Color.rgb(190, 198, 207));
        label.setPadding(0, dp(14), 0, dp(6));
        return label;
    }

    private EditText input(String hint, boolean password) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.rgb(135, 143, 153));
        input.setTextSize(16);
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setMinHeight(dp(54));
        input.setBackgroundColor(Color.rgb(42, 47, 54));
        input.setInputType(password
                ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        return input;
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(Color.WHITE);
        if (bold) view.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(16);
        button.setTextColor(Color.WHITE);
        button.setGravity(Gravity.CENTER);
        button.setBackgroundColor(Color.rgb(22, 139, 255));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(54)
        );
        params.setMargins(0, dp(10), 0, 0);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
