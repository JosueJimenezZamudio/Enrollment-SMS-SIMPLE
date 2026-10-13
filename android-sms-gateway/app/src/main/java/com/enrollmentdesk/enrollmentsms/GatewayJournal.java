package com.enrollmentdesk.enrollmentsms;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.json.JSONObject;

/** All safety writes are synchronous transactions. No network runs in a transaction. */
final class GatewayJournal extends SQLiteOpenHelper {
  static final String AUTH_ATTENTION =
      "Authorization unavailable; verify and save same-device credentials";
  private static GatewayJournal instance;

  static synchronized GatewayJournal get(Context context) {
    if (instance == null) instance = new GatewayJournal(context.getApplicationContext());
    return instance;
  }

  GatewayJournal(Context context) {
    super(
        context,
        "gateway-journal.db",
        null,
        1,
        db -> {
          // The default corruption handler deletes the journal. Preserve evidence and fail closed
          // instead.
          throw new android.database.sqlite.SQLiteDatabaseCorruptException(
              "Journal corrupt; preserve for operator recovery");
        });
    setWriteAheadLoggingEnabled(
        false); // One connection with synchronous=FULL, no async safety writes.
  }

  @Override
  public void onConfigure(SQLiteDatabase db) {
    db.setForeignKeyConstraintsEnabled(true);
    db.execSQL("PRAGMA synchronous=FULL");
    try (Cursor c = db.rawQuery("PRAGMA synchronous", null)) {
      if (!c.moveToFirst() || c.getInt(0) != 2)
        throw new IllegalStateException("Durable storage unavailable");
    }
  }

  @Override
  public void onCreate(SQLiteDatabase db) {
    db.execSQL("CREATE TABLE profiles(id TEXT PRIMARY KEY,url TEXT NOT NULL,device TEXT NOT NULL)");
    db.execSQL(
        "CREATE TABLE requests(id TEXT PRIMARY KEY,profile TEXT NOT NULL REFERENCES"
            + " profiles(id),active INTEGER NOT NULL DEFAULT 1,result TEXT,receipt TEXT)");
    db.execSQL("CREATE UNIQUE INDEX one_request ON requests(active) WHERE active=1");
    db.execSQL(
        "CREATE TABLE attempts(id TEXT PRIMARY KEY,request TEXT NOT NULL UNIQUE REFERENCES"
            + " requests(id),queue TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT NOT NULL,phone"
            + " TEXT,body TEXT,sim INTEGER,guard_at TEXT,callback_uri TEXT)");
    db.execSQL(
        "CREATE TABLE outcomes(attempt TEXT PRIMARY KEY REFERENCES attempts(id),event TEXT NOT NULL"
            + " UNIQUE,kind TEXT NOT NULL,payload TEXT NOT NULL,callback_code INTEGER,acked INTEGER"
            + " NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL"
            + " DEFAULT 0,blocked_reason TEXT,receipt TEXT)");
    db.execSQL(
        "CREATE TRIGGER immutable_outcome BEFORE UPDATE OF event,kind,payload,callback_code ON"
            + " outcomes BEGIN SELECT RAISE(ABORT,'immutable outcome'); END");
    db.execSQL(
        "CREATE TABLE health(id INTEGER PRIMARY KEY CHECK(id=1),attention TEXT NOT NULL DEFAULT"
            + " '',status TEXT NOT NULL DEFAULT 'Stopped',last_guard TEXT)");
    db.execSQL("INSERT INTO health(id) VALUES(1)");
    db.execSQL(
        "CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,attempt TEXT,kind TEXT NOT"
            + " NULL,at TEXT NOT NULL)");
  }

  @Override
  public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    throw new IllegalStateException("Journal upgrade requires explicit migration");
  }

  static final class Slot {
    String request, profile, attempt, queue, phase, phone, body, receipt;
  }

  static final class Outcome {
    String attempt, profile, request, event, kind, payload;
    boolean blocked, acked;
  }

  private static ContentValues values(String... pairs) {
    ContentValues v = new ContentValues();
    for (int i = 0; i < pairs.length; i += 2) v.put(pairs[i], pairs[i + 1]);
    return v;
  }

  private interface Write {
    void run(SQLiteDatabase db) throws Exception;
  }

  private void transaction(Write write) throws Exception {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      write.run(db);
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
  }

  synchronized void profile(String id, String url, String device) throws Exception {
    transaction(
        db -> {
          try (Cursor c =
              db.rawQuery("SELECT url,device FROM profiles WHERE id=?", new String[] {id})) {
            if (c.moveToFirst()) {
              if (!url.equals(c.getString(0)) || !device.equals(c.getString(1)))
                throw new IllegalStateException("Profile identity changed");
            } else
              db.insertOrThrow("profiles", null, values("id", id, "url", url, "device", device));
          }
        });
  }

  synchronized void requireProfile(GatewayConfig config) {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT url,device FROM profiles WHERE id=?", new String[] {config.profileId})) {
      if (!c.moveToFirst()
          || !config.supabaseUrl.equals(c.getString(0))
          || !config.deviceId.equals(c.getString(1)))
        throw new IllegalStateException("Profile verification required");
    }
  }

  synchronized Slot active() {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT r.id,r.profile,a.id,a.queue,a.phase,a.phone,a.body,a.receipt FROM requests"
                    + " r LEFT JOIN attempts a ON a.request=r.id WHERE r.active=1",
                null)) {
      if (!c.moveToFirst()) return null;
      Slot s = new Slot();
      s.request = c.getString(0);
      s.profile = c.getString(1);
      s.attempt = c.getString(2);
      s.queue = c.getString(3);
      s.phase = c.isNull(4) ? "CLAIM_PENDING" : c.getString(4);
      s.phone = c.getString(5);
      s.body = c.getString(6);
      s.receipt = c.getString(7);
      return s;
    }
  }

  synchronized Slot request(String profile) throws Exception {
    transaction(
        db -> {
          if (active() == null)
            db.insertOrThrow(
                "requests", null, values("id", UUID.randomUUID().toString(), "profile", profile));
          else if (!active().profile.equals(profile))
            throw new IllegalStateException("Pending profile mismatch");
        });
    return active();
  }

  synchronized void accept(String request, JSONObject response) throws Exception {
    transaction(
        db -> {
          Slot s = active();
          if (s == null || !s.request.equals(request))
            return; // a reporter may have released this slot
          String result = response.getString("result");
          if (!RpcReceipt.uuid(response, "claim_request_id").equals(request))
            throw new IllegalArgumentException("Claim mismatch");
          JSONObject receiptSummary = new JSONObject(response.toString());
          receiptSummary.remove("message");
          db.update(
              "requests",
              values("result", result, "receipt", receiptSummary.toString()),
              "id=?",
              new String[] {request});
          if (result.equals("empty")) {
            if (s.attempt != null) throw new IllegalArgumentException("Attempt disappeared");
            release(db, request);
            return;
          }
          if (result.equals("busy")) {
            attention(db, "Unrecognized backend claim; operator reconciliation required");
            return;
          }
          RpcReceipt r = new RpcReceipt(response);
          if (s.attempt != null) r.matches(s.attempt, s.queue);
          if (s.attempt == null) {
            JSONObject message = response.optJSONObject("message");
            db.insertOrThrow(
                "attempts",
                null,
                values(
                    "id",
                    r.attemptId,
                    "request",
                    request,
                    "queue",
                    r.queueId,
                    "phase",
                    result.equals("claimed") ? "PREPARED" : "UNCERTAIN",
                    "receipt",
                    response.toString(),
                    "phone",
                    message == null ? null : message.getString("to_phone"),
                    "body",
                    message == null ? null : message.getString("body")));
          } else
            db.update(
                "attempts",
                values("receipt", response.toString()),
                "id=?",
                new String[] {r.attemptId});
          Outcome outcome = outcome(r.attemptId);
          if (result.equals("expired")) {
            // Only server-confirmed unstarted expiry frees a possibly abandoned dispatch guard.
            db.update(
                "attempts",
                values("phase", "RETIRED_UNSTARTED", "phone", null, "body", null),
                "id=?",
                new String[] {r.attemptId});
            if (outcome != null)
              db.execSQL(
                  "UPDATE outcomes SET blocked=1 WHERE attempt=?", new Object[] {r.attemptId});
            event(db, r.attemptId, "server_unstarted_expiry");
            release(db, request);
          } else if (r.terminal() && outcome == null) {
            db.update(
                "attempts",
                values("phase", "REMOTE_COMPLETED", "phone", null, "body", null),
                "id=?",
                new String[] {r.attemptId});
            event(db, r.attemptId, "remote_completion_without_local_callback");
            release(db, request);
          } else if (result.equals("sending") || result.equals("unknown")) {
            if (outcome == null)
              db.update(
                  "attempts", values("phase", "UNCERTAIN"), "id=?", new String[] {r.attemptId});
          } else if (result.equals("cancelled"))
            attention(db, "Cancelled attempt requires operator review");
        });
  }

  synchronized boolean guard(String attempt, int sim, String uri) throws Exception {
    final boolean[] won = {false};
    transaction(
        db -> {
          ContentValues v =
              values(
                  "phase",
                  "DISPATCH_COMMITTED",
                  "guard_at",
                  Instant.now().toString(),
                  "callback_uri",
                  uri);
          v.put("sim", sim);
          won[0] =
              db.update("attempts", v, "id=? AND phase='PREPARED'", new String[] {attempt}) == 1;
          if (won[0])
            db.update("health", values("last_guard", Instant.now().toString()), "id=1", null);
        });
    return won[0];
  }

  synchronized void uncertain(String attempt) throws Exception {
    transaction(
        db ->
            db.update(
                "attempts",
                values("phase", "UNCERTAIN"),
                "id=? AND phase='DISPATCH_COMMITTED'",
                new String[] {attempt}));
  }

  synchronized boolean dispatchable(String attempt) {
    Slot s = active();
    return s != null
        && attempt.equals(s.attempt)
        && s.phase.equals("DISPATCH_COMMITTED")
        && attention().isEmpty();
  }

  synchronized void callback(String profile, String attempt, int code) throws Exception {
    transaction(
        db -> {
          try (Cursor c =
              db.rawQuery(
                  "SELECT r.profile,a.phase FROM attempts a JOIN requests r ON r.id=a.request WHERE"
                      + " a.id=?",
                  new String[] {attempt})) {
            if (!c.moveToFirst() || !profile.equals(c.getString(0))) {
              event(db, null, "unbound_callback");
              attention(db, "Unbound callback; operator review required");
              return;
            }
            Outcome prior = outcome(attempt);
            if (prior != null) {
              try (Cursor old =
                  db.rawQuery(
                      "SELECT callback_code FROM outcomes WHERE attempt=?",
                      new String[] {attempt})) {
                old.moveToFirst();
                if (old.isNull(0) || old.getInt(0) != code) {
                  event(db, attempt, "contradictory_callback");
                  attention(db, "Conflicting callbacks; evidence retained");
                  db.execSQL(
                      "UPDATE outcomes SET blocked=1,blocked_reason='REVIEW' WHERE attempt=? AND"
                          + " acked=0",
                      new Object[] {attempt});
                }
              }
              return;
            }
            if (!c.getString(1).equals("DISPATCH_COMMITTED")
                && !c.getString(1).equals("UNCERTAIN")) {
              event(db, attempt, "callback_in_unexpected_phase");
              attention(db, "Unexpected callback; operator review required");
              return;
            }
            freeze(
                db,
                attempt,
                code == Activity.RESULT_OK ? "sent" : "failed",
                code,
                code == Activity.RESULT_OK
                    ? null
                    : "Android SMS send failed with result code " + code);
          }
        });
  }

  synchronized void preflightFailure(String attempt, String reason) throws Exception {
    transaction(
        db -> {
          Slot s = active();
          if (s == null || !attempt.equals(s.attempt) || !s.phase.equals("PREPARED")) return;
          freeze(db, attempt, "failed", null, reason);
        });
  }

  private void freeze(SQLiteDatabase db, String attempt, String kind, Integer code, String error)
      throws Exception {
    String queue;
    try (Cursor c = db.rawQuery("SELECT queue FROM attempts WHERE id=?", new String[] {attempt})) {
      if (!c.moveToFirst()) throw new IllegalStateException("Missing attempt");
      queue = c.getString(0);
    }
    String event = UUID.randomUUID().toString();
    JSONObject metadata =
        new JSONObject()
            .put("app_version", SupabaseGatewayClient.APP_VERSION)
            .put("android_sdk", Build.VERSION.SDK_INT)
            .put("recorded_at", Instant.now().toString())
            .put("source", code == null ? "preflight" : "android_callback");
    if (code != null) metadata.put("android_sent_result_code", code);
    JSONObject payload =
        new JSONObject()
            .put("p_queue_id", queue)
            .put("p_attempt_id", attempt)
            .put("p_outcome_event_id", event)
            .put("p_metadata", metadata);
    if (kind.equals("sent")) payload.put("p_sms_message_id", "android:" + attempt);
    else payload.put("p_error", error);
    ContentValues v =
        values("attempt", attempt, "event", event, "kind", kind, "payload", payload.toString());
    if (code != null) v.put("callback_code", code);
    db.insertOrThrow("outcomes", null, v);
    db.update("attempts", values("phase", "OUTCOME_PENDING"), "id=?", new String[] {attempt});
  }

  synchronized Outcome outcome(String attempt) {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT o.attempt,r.profile,r.id,o.event,o.kind,o.payload,o.blocked,o.acked FROM"
                    + " outcomes o JOIN attempts a ON a.id=o.attempt JOIN requests r ON"
                    + " r.id=a.request WHERE o.attempt=?",
                new String[] {attempt})) {
      if (!c.moveToFirst()) return null;
      Outcome o = new Outcome();
      o.attempt = c.getString(0);
      o.profile = c.getString(1);
      o.request = c.getString(2);
      o.event = c.getString(3);
      o.kind = c.getString(4);
      o.payload = c.getString(5);
      o.blocked = c.getInt(6) != 0;
      o.acked = c.getInt(7) != 0;
      return o;
    }
  }

  synchronized List<Outcome> pending() {
    List<Outcome> result = new ArrayList<>();
    try (Cursor c =
        getReadableDatabase()
            .rawQuery("SELECT attempt FROM outcomes WHERE acked=0 AND blocked=0", null)) {
      while (c.moveToNext()) result.add(outcome(c.getString(0)));
    }
    return result;
  }

  synchronized void acknowledge(Outcome o, RpcReceipt receipt) throws Exception {
    receipt.acknowledge(new JSONObject(o.payload), o.kind);
    transaction(
        db -> {
          Outcome current = outcome(o.attempt);
          if (current == null || !current.event.equals(o.event))
            throw new IllegalStateException("Outcome changed");
          db.execSQL(
              "UPDATE outcomes SET acked=1,receipt=? WHERE attempt=?",
              new Object[] {receipt.json.toString(), o.attempt});
          db.update(
              "attempts",
              values(
                  "phase",
                  "ACKNOWLEDGED",
                  "phone",
                  null,
                  "body",
                  null,
                  "receipt",
                  receipt.json.toString()),
              "id=?",
              new String[] {o.attempt});
          release(db, o.request);
        });
  }

  synchronized long reportNotBefore(String attempt) {
    try (Cursor c =
        getReadableDatabase()
            .rawQuery("SELECT not_before FROM outcomes WHERE attempt=?", new String[] {attempt})) {
      return c.moveToFirst() ? c.getLong(0) : 0;
    }
  }

  synchronized void deferReport(String attempt, long delay) {
    getWritableDatabase()
        .execSQL(
            "UPDATE outcomes SET not_before=? WHERE attempt=?",
            new Object[] {System.currentTimeMillis() + delay, attempt});
  }

  synchronized void block(Outcome o, String reason) throws Exception {
    transaction(
        db -> {
          db.execSQL(
              "UPDATE outcomes SET blocked=1,blocked_reason=CASE WHEN blocked_reason='REVIEW' THEN"
                  + " 'REVIEW' ELSE ? END WHERE attempt=?",
              new Object[] {reason.equals(AUTH_ATTENTION) ? "AUTH" : "REVIEW", o.attempt});
          attention(db, reason);
        });
  }

  synchronized void repairedCredentials(String profile) throws Exception {
    transaction(
        db -> {
          db.execSQL(
              "UPDATE outcomes SET blocked=0,blocked_reason=NULL WHERE blocked_reason='AUTH' AND"
                  + " attempt IN (SELECT a.id FROM attempts a JOIN requests r ON r.id=a.request"
                  + " WHERE r.profile=?)",
              new Object[] {profile});
          db.update(
              "health",
              values("attention", ""),
              "id=1 AND attention=?",
              new String[] {AUTH_ATTENTION});
        });
  }

  synchronized void attention(String reason) throws Exception {
    transaction(db -> attention(db, reason));
  }

  synchronized String attention() {
    try (Cursor c =
        getReadableDatabase().rawQuery("SELECT attention FROM health WHERE id=1", null)) {
      c.moveToFirst();
      return c.getString(0);
    }
  }

  synchronized void status(String status) {
    getWritableDatabase().update("health", values("status", status), "id=1", null);
  }

  synchronized String status() {
    try (Cursor c =
        getReadableDatabase().rawQuery("SELECT attention,status FROM health WHERE id=1", null)) {
      c.moveToFirst();
      return c.getString(0).isEmpty() ? c.getString(1) : "Attention: " + c.getString(0);
    }
  }

  private static void attention(SQLiteDatabase db, String reason) {
    db.update(
        "health",
        values("attention", reason),
        reason.equals(AUTH_ATTENTION) ? "id=1 AND attention=''" : "id=1",
        null);
  }

  private static void release(SQLiteDatabase db, String request) {
    db.execSQL("UPDATE requests SET active=0 WHERE id=?", new Object[] {request});
  }

  private static void event(SQLiteDatabase db, String attempt, String kind) {
    db.insertOrThrow(
        "events", null, values("attempt", attempt, "kind", kind, "at", Instant.now().toString()));
    db.execSQL(
        "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 200)");
  }
}
