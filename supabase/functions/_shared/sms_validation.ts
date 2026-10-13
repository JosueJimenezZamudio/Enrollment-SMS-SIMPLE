const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
    .split(""),
);
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

export function gsm7Septets(value: string): number | null {
  let total = 0;
  for (const ch of value) {
    if (GSM7_BASIC.has(ch)) total += 1;
    else if (GSM7_EXT.has(ch)) total += 2;
    else return null;
  }
  return total;
}

export function normalizeUsPhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}
