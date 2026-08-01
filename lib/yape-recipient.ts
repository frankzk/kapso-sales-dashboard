export type YapeRecipientCheck = "verified" | "partial" | "mismatch" | "missing";

export interface YapeRecipientVerification {
  status: YapeRecipientCheck;
  nameMatches: boolean;
  phoneMatches: boolean;
  hasName: boolean;
  hasPhone: boolean;
}

export interface YapeRecipientReading {
  name: string | null;
  phoneLastDigits: string | null;
  status: YapeRecipientCheck;
}

function comparableRecipientName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Verifica por separado las dos señales visibles de la cuenta receptora Yape.
 * Se acepta el celular completo 930 555 309 o cualquier lectura que conserve
 * con certeza sus tres últimos dígitos, 309.
 */
export function verifyYapeRecipient(
  recipientName: string | null | undefined,
  recipientPhone: string | null | undefined,
): YapeRecipientVerification {
  const name = comparableRecipientName(recipientName);
  const phone = (recipientPhone ?? "").replace(/\D/g, "");
  const hasName = Boolean(name);
  const hasPhone = phone.length >= 3;
  const nameMatches = hasName && name.includes("grupo gf") && /\bs\s*a\s*c\b/.test(name);
  const phoneMatches = hasPhone && phone.endsWith("309");

  let status: YapeRecipientCheck = "missing";
  if ((hasName && !nameMatches) || (hasPhone && !phoneMatches)) status = "mismatch";
  else if (nameMatches && phoneMatches) status = "verified";
  else if (nameMatches || phoneMatches) status = "partial";

  return { status, nameMatches, phoneMatches, hasName, hasPhone };
}

export function checkYapeRecipient(
  recipientName: string | null | undefined,
  recipientPhone: string | null | undefined,
): YapeRecipientCheck {
  return verifyYapeRecipient(recipientName, recipientPhone).status;
}

/** Lee la auditoría JSON guardada con cada comprobante sin confiar en su estado. */
export function yapeRecipientReadingFromVision(vision: unknown): YapeRecipientReading {
  const root = vision && typeof vision === "object" ? vision as Record<string, unknown> : {};
  const extracted = root.extracted && typeof root.extracted === "object"
    ? root.extracted as Record<string, unknown>
    : {};
  const name = typeof extracted.recipient_name === "string"
    ? extracted.recipient_name.trim() || null
    : null;
  const rawPhone = typeof extracted.recipient_phone_last_digits === "string"
    ? extracted.recipient_phone_last_digits
    : null;
  const digits = (rawPhone ?? "").replace(/\D/g, "");
  const phoneLastDigits = digits.length >= 3 ? digits.slice(-3) : null;
  return {
    name,
    phoneLastDigits,
    status: checkYapeRecipient(name, phoneLastDigits),
  };
}
