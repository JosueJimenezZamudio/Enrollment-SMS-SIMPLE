package com.enrollmentdesk.enrollmentsms;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;

final class AndroidSmsTransport implements GatewayCoordinator.Transport {
  private final Context context;

  AndroidSmsTransport(Context c) {
    context = c;
  }

  static boolean singleGsmSegment(String body) {
    String basic =
        "@£$¥èéùìòÇ\n"
            + "Øø\r"
            + "ÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ"
            + " !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    String extension = "\f^{}\\[~]|€";
    int septets = 0;
    for (char ch : body.toCharArray()) {
      if (basic.indexOf(ch) >= 0) septets++;
      else if (extension.indexOf(ch) >= 0) septets += 2;
      else return false;
    }
    return septets > 0 && septets <= 160;
  }

  private SmsManager manager(int sim) {
    if (Build.VERSION.SDK_INT >= 31)
      return context.getSystemService(SmsManager.class).createForSubscriptionId(sim);
    return SmsManager.getSmsManagerForSubscriptionId(sim);
  }

  @Override
  public int preflight(GatewayJournal.Slot s) throws Exception {
    if (context.checkSelfPermission(Manifest.permission.SEND_SMS)
        != PackageManager.PERMISSION_GRANTED)
      throw new GatewayCoordinator.PreflightFailure("SEND_SMS permission unavailable");
    int sim = SubscriptionManager.getDefaultSmsSubscriptionId();
    if (sim < 0 || sim == SubscriptionManager.DEFAULT_SUBSCRIPTION_ID)
      throw new GatewayCoordinator.PreflightFailure("Choose an explicit default SMS SIM");
    if (s.phone == null
        || !s.phone.matches("\\+1[0-9]{10}")
        || s.body == null
        || !singleGsmSegment(s.body)
        || manager(sim).divideMessage(s.body).size() != 1)
      throw new GatewayCoordinator.PreflightFailure(
          "Blocked by gateway: US phone and one GSM-7 segment required");
    return sim;
  }

  @Override
  public void submit(GatewayJournal.Slot s, int sim, String uri) {
    Intent intent =
        new Intent(context, SmsSentReceiver.class)
            .setAction(SmsGatewayService.ACTION_SMS_SENT)
            .setData(Uri.parse(uri));
    PendingIntent callback =
        PendingIntent.getBroadcast(
            context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    manager(sim).sendTextMessage(s.phone, null, s.body, callback, null);
  }
}
