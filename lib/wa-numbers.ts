// WhatsApp number attribution — which business number a lead wrote to. Kapso
// stamps every conversation with the destination `phone_number_id`; we resolve
// that id to a friendly name / display phone / kind (API vs Business
// coexistence) via the `whatsapp_numbers` lookup. Pure module (client-safe).

export interface WaNumber {
  phoneNumberId: string;
  name: string | null;
  displayPhone: string | null;
  kind: string | null; // 'api' | 'business' (coexistence) | 'sandbox'
}

/** Short human tag for a number kind (null when unknown / not worth showing). */
export function waKindLabel(kind: string | null | undefined): string | null {
  switch (kind) {
    case "api":
      return "API";
    case "business":
      return "Business";
    case "sandbox":
      return "Sandbox";
    default:
      return null;
  }
}

/** Best short label for a number: its name → display phone → the raw id. */
export function waLabel(n: WaNumber | null | undefined, phoneNumberId: string): string {
  return n?.name || n?.displayPhone || phoneNumberId;
}
