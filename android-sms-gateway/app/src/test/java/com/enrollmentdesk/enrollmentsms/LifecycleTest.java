package com.enrollmentdesk.enrollmentsms;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.Service;
import android.content.Context;
import java.lang.reflect.Field;
import java.util.UUID;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(
    sdk = {34, 35},
    application = Application.class)
public class LifecycleTest {
  Context context;

  @Before
  public void setup() throws Exception {
    resetJournal();
    context = RuntimeEnvironment.getApplication();
    context.deleteDatabase("gateway-journal.db");
    context.getSharedPreferences(GatewayConfig.PREFS, 0).edit().clear().commit();
    context.getSharedPreferences("pending_sends", 0).edit().clear().commit();
    DispatchGate.stop();
    GatewayApplication.storageFailed = false;
  }

  @After
  public void cleanup() throws Exception {
    DispatchGate.stop();
    resetJournal();
  }

  void resetJournal() throws Exception {
    Field field = GatewayJournal.class.getDeclaredField("instance");
    field.setAccessible(true);
    GatewayJournal prior = (GatewayJournal) field.get(null);
    if (prior != null) prior.close();
    field.set(null, null);
  }

  @Test
  public void upgradeDisablesOldEnabledFlagAndKeepsLegacyEvidence() throws Exception {
    context
        .getSharedPreferences(GatewayConfig.PREFS, 0)
        .edit()
        .putBoolean("enabled", true)
        .commit();
    context
        .getSharedPreferences("pending_sends", 0)
        .edit()
        .putString("old-record", "legacy-evidence")
        .commit();
    GatewayConfig.initialize(context);
    assertFalse(context.getSharedPreferences(GatewayConfig.PREFS, 0).getBoolean("enabled", true));
    assertEquals(
        "legacy-evidence",
        context.getSharedPreferences("pending_sends", 0).getString("old-record", null));
    assertFalse(GatewayJournal.get(context).attention().isEmpty());
    assertFalse(DispatchGate.running());
  }

  @Test
  public void missingJournalWithSavedProfileRequiresOperatorReview() throws Exception {
    context
        .getSharedPreferences(GatewayConfig.PREFS, 0)
        .edit()
        .putString("profile_id", UUID.randomUUID().toString())
        .commit();
    GatewayConfig.initialize(context);
    assertFalse(GatewayJournal.get(context).attention().isEmpty());
  }

  @Test
  public void unresolvedClaimBlocksProjectAndDeviceChangesButAllowsVerifiedCredentialRepair()
      throws Exception {
    GatewayConfig.initialize(context);
    String device = UUID.randomUUID().toString();
    GatewayConfig config =
        new GatewayConfig(
            "https://example.supabase.co", "sb_publishable_test", "token-a", 5, "", "");
    GatewayConfig.saveVerified(context, config, device);
    GatewayConfig saved = GatewayConfig.load(context);
    GatewayJournal.get(context).request(saved.profileId);
    GatewayConfig other =
        new GatewayConfig("https://other.supabase.co", "sb_publishable_test", "token-b", 5, "", "");
    assertThrows(Exception.class, () -> GatewayConfig.saveVerified(context, other, device));
    assertThrows(
        Exception.class,
        () -> GatewayConfig.saveVerified(context, config, UUID.randomUUID().toString()));
    GatewayConfig repair =
        new GatewayConfig(config.supabaseUrl, config.apiKey, "token-repaired", 5, "", "");
    GatewayConfig.saveVerified(context, repair, device);
    assertEquals(saved.profileId, GatewayConfig.load(context).profileId);
    assertEquals("token-repaired", GatewayConfig.load(context).deviceToken);
  }

  @Test
  public void timeoutInvalidatesContinuationAndDoesNotRestartService() {
    var controller = Robolectric.buildService(SmsGatewayService.class).create();
    SmsGatewayService service = controller.get();
    long owner = DispatchGate.start();
    service.onTimeout(1, 1);
    assertFalse(DispatchGate.valid(owner));
    assertEquals(Service.START_NOT_STICKY, service.onStartCommand(null, 0, 2));
    controller.destroy();
  }

  @Test
  public void openingActivityDoesNotStartGateway() {
    var activity = Robolectric.buildActivity(MainActivity.class).setup();
    assertFalse(DispatchGate.running());
    activity.pause().stop().destroy();
  }

  @Test
  public void processInitializationPreservesContinuousIntent() throws Exception {
    GatewayConfig.initialize(context);
    context
        .getSharedPreferences(GatewayConfig.PREFS, 0)
        .edit()
        .putBoolean("enabled", true)
        .putInt("bound_sms_sim", 2)
        .commit();
    GatewayConfig.initialize(context);
    assertTrue(GatewayLifecycle.enabled(context));
    assertEquals(2, GatewayLifecycle.boundSim(context));
    assertFalse(DispatchGate.running());
  }

  @Test
  public void explicitStopPersistsAcrossInitialization() throws Exception {
    GatewayConfig.initialize(context);
    context
        .getSharedPreferences(GatewayConfig.PREFS, 0)
        .edit()
        .putBoolean("enabled", true)
        .commit();
    long owner = DispatchGate.start();
    GatewayLifecycle.disable(context);
    GatewayConfig.initialize(context);
    assertFalse(GatewayLifecycle.enabled(context));
    assertFalse(DispatchGate.valid(owner));
    assertFalse(GatewayLifecycle.restore(context));
  }

  @Test
  public void android15DoesNotRestoreDataSyncFromBoot() {
    context
        .getSharedPreferences(GatewayConfig.PREFS, 0)
        .edit()
        .putBoolean("enabled", true)
        .commit();
    if (android.os.Build.VERSION.SDK_INT >= 35) assertFalse(GatewayLifecycle.restore(context));
    else assertTrue(GatewayLifecycle.restore(context));
    assertFalse(DispatchGate.running());
  }

  @Test
  public void rejectsSecretKeysAndNonCanonicalProjectUrls() {
    assertFalse(
        new GatewayConfig("http://example.supabase.co", "sb_publishable_test", "t", 5, "", "")
            .isReady());
    assertFalse(
        new GatewayConfig("https://example.supabase.co/path", "sb_publishable_test", "t", 5, "", "")
            .isReady());
    assertFalse(
        new GatewayConfig("https://example.supabase.co", "sb_secret_test", "t", 5, "", "")
            .isReady());
    assertTrue(
        new GatewayConfig("https://example.supabase.co/", "sb_publishable_test", "t", 5, "", "")
            .isReady());
  }
}
