// deno-lint-ignore-file require-await
// RPC doubles intentionally preserve the asynchronous production interface.
import {
  producerHandler,
  type Rpc,
} from "../functions/_shared/producer_api.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const secret = "test-only-ingest-secret";
const readSecret = "test-only-read-secret";
const id = "00000000-0000-0000-0000-000000000001";
const snapshot = {
  id,
  dedupe_key: "event:lead:sms",
  status: "queued",
  scheduled_at: "2030-01-01T00:00:00Z",
  claimed_at: null,
  sent_at: null,
  failed_at: null,
  last_error: null,
  attempt_status: null,
};
const valid = {
  phone: "202-555-0123",
  message: "Enrollment test.",
  dedupeKey: "event:lead:sms",
};
function request(payload: unknown, token = secret, method = "POST") {
  return new Request("http://localhost/test", {
    method,
    headers: {
      "x-enrollment-sms-secret": token,
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
}
function handler(
  mode: "ingest" | "status",
  rpc: Rpc,
  expected = mode === "ingest" ? secret : readSecret,
) {
  return producerHandler(
    mode,
    { secret: expected, clientId: "sheet-worker" },
    rpc,
  );
}
const unreachable: Rpc = () => {
  throw new Error("RPC must not be called");
};
for (const mode of ["ingest", "status"] as const) {
  for (const token of ["", "wrong", mode === "ingest" ? readSecret : secret]) {
    Deno.test(`${mode}: unauthorized ${token || "missing"}`, async () => {
      assert(
        (await handler(mode, unreachable)(request(valid, token))).status ===
          401,
      );
    });
  }
  Deno.test(`${mode}: missing configured secret fails closed`, async () => {
    assert(
      (await handler(mode, unreachable, "")(request(valid, ""))).status === 401,
    );
  });
  Deno.test(`${mode}: method and malformed bodies`, async () => {
    const h = handler(mode, unreachable),
      token = mode === "ingest" ? secret : readSecret;
    assert((await h(request(null, token, "GET"))).status === 405);
    assert((await h(request(null, token, "OPTIONS"))).status === 200);
    for (const body of ["{", "null", "[]", '"text"']) {
      const r = await h(
        new Request("http://localhost/test", {
          method: "POST",
          headers: { "x-enrollment-sms-secret": token },
          body,
        }),
      );
      assert(r.status === 400);
    }
  });
}
for (
  const [label, patch] of Object.entries({
    phone: { phone: "123" },
    numericPhone: { phone: 2025550123 },
    empty: { message: " " },
    unicode: { message: "Hello 🙂" },
    long: { message: "a".repeat(161) },
    extensionLength: { message: "^".repeat(81) },
    missingKey: { dedupeKey: null },
    emptyKey: { dedupeKey: " " },
    longKey: { dedupeKey: "x".repeat(201) },
    impossibleDate: { scheduledAt: "2030-02-30T00:00:00Z" },
    nonLeapDate: { scheduledAt: "2030-02-29T00:00:00Z" },
    invalidHour: { scheduledAt: "2030-01-01T24:00:00Z" },
    invalidSchedule: { scheduledAt: "yesterday" },
    noTimezone: { scheduledAt: "2030-01-01T00:00:00" },
    badLead: { leadId: {} },
    badEvent: { eventType: [] },
    routingInjection: { deviceId: id },
    clientInjection: { clientId: "other" },
    unexpected: { extra: "not frozen" },
  })
) {
  Deno.test(`ingest validation: ${label}`, async () => {
    assert(
      (await handler("ingest", unreachable)(request({ ...valid, ...patch })))
        .status === 400,
    );
  });
}
Deno.test("ingest: canonical payload, preserved omitted schedule, created receipt", async () => {
  const h = handler("ingest", async (name, args) => {
    assert(
      name === "producer_enqueue_sms" && args.p_client_id === "sheet-worker",
    );
    assert(args.p_phone === "+12025550123" && args.p_message === valid.message);
    assert(
      args.p_scheduled_at === null && args.p_lead_id === null &&
        args.p_event_type === null,
    );
    return { data: { result: "created", queued: snapshot }, error: null };
  });
  const r = await h(request({ ...valid, message: ` ${valid.message} ` }));
  assert(r.status === 201 && r.headers.get("cache-control") === "no-store");
  assert((await r.json()).queued.id === id);
});
Deno.test("ingest: timezone normalization and GSM extension boundary", async () => {
  const h = handler("ingest", async (_, args) => {
    assert(args.p_scheduled_at === "2030-01-01T08:00:00.000Z");
    return { data: { result: "created", queued: snapshot }, error: null };
  });
  assert(
    (await h(
      request({
        ...valid,
        message: "^".repeat(80),
        scheduledAt: "2030-01-01T00:00:00-08:00",
      }),
    )).status === 201,
  );
});
Deno.test("ingest: duplicate current receipt and conflict have distinct responses", async () => {
  for (const result of ["duplicate", "conflict", "client_unavailable"]) {
    const r = await handler(
      "ingest",
      async () => ({
        data: { result, queued: { ...snapshot, status: "sent" } },
        error: null,
      }),
    )(request(valid));
    assert(
      r.status ===
        ({ duplicate: 200, conflict: 409, client_unavailable: 503 })[result],
    );
    const body = await r.json();
    if (result === "duplicate") {
      assert(
        body.duplicate === true && body.queued.id === id &&
          body.queued.status === "sent",
      );
    } else assert(!body.queued && !body.id);
  }
});
for (
  const state of [
    "queued",
    "claimed",
    "sending",
    "unknown",
    "sent",
    "failed",
    "cancelled",
  ]
) {
  Deno.test(`status: minimal ${state} projection`, async () => {
    const h = handler("status", async (name, args) => {
      assert(
        name === "producer_sms_status" && args.p_client_id === "sheet-worker",
      );
      assert(args.p_queue_id === id && args.p_dedupe_key === valid.dedupeKey);
      return {
        data: {
          ...snapshot,
          status: state,
          attempt_status: state === "queued" ? null : state,
          body: "must not leak",
          phone: "must not leak",
          device_token: "must not leak",
        },
        error: null,
      };
    });
    const r = await h(
      request({ queueId: id, dedupeKey: valid.dedupeKey }, readSecret),
    );
    const data = (await r.json()).queued;
    assert(r.status === 200 && data.status === state);
    assert(
      Object.keys(data).sort().join() === Object.keys(snapshot).sort().join(),
    );
  });
}
Deno.test("status: selectors, missing queue and mismatched identity", async () => {
  for (
    const payload of [{ queueId: id }, { dedupeKey: valid.dedupeKey }, {
      queueId: id,
      dedupeKey: "other",
    }]
  ) {
    assert(
      (await handler("status", async () => ({ data: null, error: null }))(
        request(payload, readSecret),
      )).status === 404,
    );
  }
  for (
    const payload of [{}, { queueId: "bad" }, { dedupeKey: "" }, {
      queueIds: [id],
    }, { queueId: id, clientId: "other" }]
  ) {
    assert(
      (await handler("status", unreachable)(request(payload, readSecret)))
        .status === 400,
    );
  }
});
Deno.test("both APIs: database errors and network exceptions are sanitized", async () => {
  for (const mode of ["ingest", "status"] as const) {
    for (
      const rpc of [
        async () => ({ data: null, error: { message: "secret contact data" } }),
        async () => {
          throw new Error("secret contact data");
        },
      ]
    ) {
      const r = await handler(mode, rpc)(
        request(
          mode === "ingest" ? valid : { queueId: id },
          mode === "ingest" ? secret : readSecret,
        ),
      );
      assert(
        r.status === 503 && !(await r.text()).includes("secret contact data"),
      );
    }
  }
});
