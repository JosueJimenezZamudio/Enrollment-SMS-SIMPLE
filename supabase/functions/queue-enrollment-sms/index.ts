import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-enrollment-sms-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split("")
);
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

function gsm7Septets(value: string): number | null {
  let total = 0;
  for (const ch of value) {
    if (GSM7_BASIC.has(ch)) total += 1;
    else if (GSM7_EXT.has(ch)) total += 2;
    else return null;
  }
  return total;
}

function normalizeUsPhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: corsHeaders });
  }

  const expectedSecret = Deno.env.get("LEAD_SMS_INGEST_SECRET") ?? "";
  const suppliedSecret = req.headers.get("x-enrollment-sms-secret") ?? "";
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const phone = normalizeUsPhone(payload.phone);
  const message = String(payload.message ?? "").trim();
  const leadId = payload.leadId == null ? null : String(payload.leadId);
  const eventType = payload.eventType == null ? null : String(payload.eventType);
  const dedupeKey = payload.dedupeKey == null ? null : String(payload.dedupeKey);
  const scheduledAt = payload.scheduledAt == null ? new Date().toISOString() : String(payload.scheduledAt);

  if (!phone) {
    return Response.json({ error: "A valid US phone number is required" }, { status: 400, headers: corsHeaders });
  }
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400, headers: corsHeaders });
  }

  const septets = gsm7Septets(message);
  if (septets == null) {
    return Response.json(
      { error: "Message contains non-GSM-7 characters. Rewrite it with plain SMS characters so it stays one segment." },
      { status: 400, headers: corsHeaders }
    );
  }
  if (septets > 160) {
    return Response.json(
      { error: "Message is more than one GSM-7 segment", septets, limit: 160 },
      { status: 400, headers: corsHeaders }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: "Server configuration is incomplete" }, { status: 500, headers: corsHeaders });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const insert = {
    lead_id: leadId,
    to_phone: phone,
    body: message,
    event_type: eventType,
    dedupe_key: dedupeKey,
    scheduled_at: scheduledAt,
    metadata: {
      source: "lead-automation",
      gsm7_septets: septets,
    },
  };

  const { data, error } = await supabase
    .from("sms_queue")
    .insert(insert)
    .select("id,status,scheduled_at")
    .single();

  if (error) {
    if (error.code === "23505" && dedupeKey) {
      return Response.json({ ok: true, duplicate: true, dedupeKey }, { status: 200, headers: corsHeaders });
    }
    return Response.json({ error: error.message, code: error.code }, { status: 500, headers: corsHeaders });
  }

  return Response.json({ ok: true, queued: data }, { status: 201, headers: corsHeaders });
});
