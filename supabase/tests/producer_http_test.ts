import { runtimeHandler } from "../functions/_shared/runtime.ts";

function assert(value: unknown): void {
  if (!value) throw new Error("HTTP contract assertion failed");
}
Deno.test("runtime: HTTP authentication, Supabase RPC arguments and minimal receipts", async () => {
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "LEAD_SMS_INGEST_SECRET",
    "LEAD_SMS_STATUS_SECRET",
    "SMS_INGEST_CLIENT_ID",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  const queued = {
    id: "00000000-0000-0000-0000-000000000001",
    dedupe_key: "http:test",
    status: "queued",
    scheduled_at: "2099-01-01T00:00:00Z",
    claimed_at: null,
    sent_at: null,
    failed_at: null,
    last_error: null,
    attempt_status: null,
  };
  let calls = 0;
  const backend = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      calls++;
      assert(req.headers.get("apikey") === "server-only-test-key");
      assert(
        req.headers.get("authorization") === "Bearer server-only-test-key",
      );
      const args = await req.json();
      assert(args.p_client_id === "test-worker");
      if (new URL(req.url).pathname === "/rest/v1/rpc/producer_enqueue_sms") {
        assert(
          args.p_phone === "+12025550123" &&
            args.p_message === "Dynamic HTTP test.",
        );
        assert(
          args.p_dedupe_key === "http:test" && args.p_scheduled_at === null,
        );
        return Response.json({ result: "created", queued });
      }
      assert(new URL(req.url).pathname === "/rest/v1/rpc/producer_sms_status");
      assert(args.p_queue_id === queued.id && args.p_dedupe_key === null);
      return Response.json({
        ...queued,
        status: "unknown",
        attempt_status: "unknown",
        phone: "must not leak",
      });
    },
  );
  let edge: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${backend.addr.port}`);
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "server-only-test-key");
    Deno.env.set("LEAD_SMS_INGEST_SECRET", "test-ingest");
    Deno.env.set("LEAD_SMS_STATUS_SECRET", "test-read");
    Deno.env.set("SMS_INGEST_CLIENT_ID", "test-worker");
    const ingest = runtimeHandler("ingest"), status = runtimeHandler("status");
    edge = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (req) =>
        new URL(req.url).pathname === "/ingest" ? ingest(req) : status(req),
    );
    const post = (path: string, token: string, body: unknown) =>
      fetch(`http://127.0.0.1:${edge!.addr.port}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-enrollment-sms-secret": token,
        },
        body: JSON.stringify(body),
      });
    let r = await post("ingest", "test-ingest", {
      phone: "2025550123",
      message: "Dynamic HTTP test.",
      dedupeKey: "http:test",
    });
    assert(r.status === 201 && (await r.json()).queued.id === queued.id);
    r = await post("status", "test-ingest", { queueId: queued.id });
    assert(r.status === 401);
    await r.text();
    assert(calls === 1);
    r = await post("ingest", "test-read", {});
    assert(r.status === 401);
    await r.text();
    assert(calls === 1);
    r = await post("status", "test-read", { queueId: queued.id });
    const body = await r.json();
    assert(
      r.status === 200 && body.queued.status === "unknown" &&
        body.queued.attempt_status === "unknown",
    );
    assert(
      !JSON.stringify(body).includes("must not leak") &&
        !JSON.stringify(body).includes("server-only-test-key"),
    );
    assert(calls === 2);
  } finally {
    await edge?.shutdown();
    await backend.shutdown();
    names.forEach((name, i) =>
      previous[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[i]!)
    );
  }
});
