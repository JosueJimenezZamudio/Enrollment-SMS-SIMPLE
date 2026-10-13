import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { producerHandler } from "./producer_api.ts";

export function runtimeHandler(mode: "ingest" | "status") {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = url && serviceKey
    ? createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    : null;
  return producerHandler(mode, {
    secret: Deno.env.get(
      mode === "ingest" ? "LEAD_SMS_INGEST_SECRET" : "LEAD_SMS_STATUS_SECRET",
    ),
    clientId: Deno.env.get("SMS_INGEST_CLIENT_ID"),
  }, async (name, args) => {
    if (!client) throw new Error("Server configuration is incomplete");
    return await client.rpc(name, args);
  });
}
