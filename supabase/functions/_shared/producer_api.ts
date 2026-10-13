import { gsm7Septets, normalizeUsPhone } from "./sms_validation.ts";

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: unknown;
}>;
export type Config = { secret?: string; clientId?: string };
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-enrollment-sms-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
function validTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) return false;
  // Date.parse normalizes invalid calendar days and 24:00; reject those inputs.
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(
    /[-T:]/,
  ).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= days[month - 1] && hour < 24 && minute < 60 && second < 60;
}
const validKey = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= 200;

// Build an explicit allowlist even if a future RPC accidentally returns more data.
function projectStatus(data: unknown) {
  if (!isObject(data)) throw new Error("Invalid status response");
  return Object.fromEntries([
    "id",
    "dedupe_key",
    "status",
    "scheduled_at",
    "claimed_at",
    "sent_at",
    "failed_at",
    "last_error",
    "attempt_status",
  ].map((key) => [key, data[key] ?? null]));
}

export function producerHandler(
  mode: "ingest" | "status",
  config: Config,
  rpc: Rpc,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return json({ error: "POST required" }, 405);
    if (
      !config.secret ||
      req.headers.get("x-enrollment-sms-secret") !== config.secret
    ) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!config.clientId) {
      return json({ error: "Server configuration is incomplete" }, 503);
    }
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!isObject(payload)) return json({ error: "JSON object required" }, 400);
    const allowed = mode === "ingest"
      ? ["phone", "message", "leadId", "eventType", "dedupeKey", "scheduledAt"]
      : ["queueId", "dedupeKey"];
    if (Object.keys(payload).some((key) => !allowed.includes(key))) {
      return json({ error: "Unsupported fields" }, 400);
    }
    let name: string;
    let args: Record<string, unknown>;
    if (mode === "status") {
      const { queueId, dedupeKey } = payload;
      if (
        (queueId == null && dedupeKey == null) ||
        (queueId != null &&
          (typeof queueId !== "string" || !uuid.test(queueId))) ||
        (dedupeKey != null && !validKey(dedupeKey))
      ) {
        return json({ error: "Supply a valid queueId and/or dedupeKey" }, 400);
      }
      name = "producer_sms_status";
      args = {
        p_client_id: config.clientId,
        p_queue_id: queueId ?? null,
        p_dedupe_key: dedupeKey ?? null,
      };
    } else {
      const phone = typeof payload.phone === "string"
        ? normalizeUsPhone(payload.phone)
        : null;
      const message = typeof payload.message === "string"
        ? payload.message.trim()
        : "";
      if (!phone) {
        return json({ error: "A valid US phone number is required" }, 400);
      }
      if (!message) return json({ error: "Message is required" }, 400);
      if (!validKey(payload.dedupeKey)) {
        return json({
          error: "A stable dedupeKey of 1–200 characters is required",
        }, 400);
      }
      for (const key of ["leadId", "eventType"]) {
        if (
          payload[key] != null &&
          (typeof payload[key] !== "string" || payload[key].length > 200)
        ) {
          return json({
            error: `${key} must be a string of at most 200 characters`,
          }, 400);
        }
      }
      const septets = gsm7Septets(message);
      if (septets === null) {
        return json({ error: "Message contains non-GSM-7 characters" }, 400);
      }
      if (septets > 160) {
        return json({
          error: "Message is more than one GSM-7 segment",
          septets,
          limit: 160,
        }, 400);
      }
      let scheduledAt: string | null = null;
      if (payload.scheduledAt != null) {
        // Require explicit timezone; never interpret a workstation/Sheet locale here.
        if (!validTimestamp(payload.scheduledAt)) {
          return json({
            error: "scheduledAt must be an ISO timestamp with timezone",
          }, 400);
        }
        scheduledAt = new Date(payload.scheduledAt).toISOString();
      }
      name = "producer_enqueue_sms";
      args = {
        p_client_id: config.clientId,
        p_dedupe_key: payload.dedupeKey,
        p_phone: phone,
        p_message: message,
        p_lead_id: payload.leadId ?? null,
        p_event_type: payload.eventType ?? null,
        p_scheduled_at: scheduledAt,
      };
    }
    try {
      const { data, error } = await rpc(name, args);
      if (error) {
        return json({
          error: "Backend unavailable; reconcile using the same dedupe key",
        }, 503);
      }
      if (mode === "status") {
        return data === null
          ? json({ error: "Queue item not found" }, 404)
          : json({ ok: true, queued: projectStatus(data) });
      }
      if (!isObject(data)) throw new Error("Invalid ingest response");
      if (data.result === "conflict") {
        return json({
          error: "Dedupe key conflicts with an existing submission",
          code: "DEDUPE_CONFLICT",
        }, 409);
      }
      if (data.result === "client_unavailable") {
        return json({ error: "Ingest client unavailable" }, 503);
      }
      if (data.result !== "created" && data.result !== "duplicate") {
        throw new Error("Invalid result");
      }
      return json({
        ok: true,
        duplicate: data.result === "duplicate",
        dedupeKey: payload.dedupeKey,
        queued: projectStatus(data.queued),
      }, data.result === "created" ? 201 : 200);
    } catch {
      // Do not return raw DB errors, credentials, contact data, or request bodies.
      return json({
        error: "Backend unavailable; reconcile using the same dedupe key",
      }, 503);
    }
  };
}
