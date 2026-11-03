// Las guías de las que Swayp avisa y que Kapta no tiene (MOM §11.2, «Guías de
// Swayp que Kapta no tiene», 26-10-2026, pedido del owner; 0282).
//
// El webhook de Swayp descartaba en silencio el aviso de una guía que no está
// en `shipments`: la creada directo en el panel de Swayp sin registrarla en
// Kapta. Pasó con #KP143754: Swayp la entregó y Kapta la seguía viendo «Por
// despachar». Ahora el aviso queda en `swayp_unknown_guides` y Envíos lo enseña
// hasta que la guía se registra («Guía Swayp directa» con el número) o alguien
// la descarta.
//
// Lo que Swayp diga de la guía al verla por primera vez (`GET /v2/guias/<n>`)
// sirve para sugerir el pedido: el número de pedido si viene escrito en algún
// campo, si no el celular del destinatario. La forma de esa respuesta no está
// documentada: se busca por el nombre de los campos y nunca se adivina.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SwaypGuideContact {
  name: string | null;
  /** Normalizado «51» + 9 dígitos. */
  phone: string | null;
  /** El número de pedido que nombra la guía («#KP143754»), o un texto de referencia. */
  reference: string | null;
}

const NAME_KEY = /(destinatario|consignatario|receptor|cliente|nombre)/i;
const PHONE_KEY = /(tel[eé]fono|telefono|celular|movil|m[oó]vil|phone|whatsapp)/i;
const REFERENCE_KEY = /(referencia|pedido|orden|order|observaci|nota|contenido)/i;
const ORDER_NAME = /#?\b(KP|AUR)\s?(\d{5,7})\b/i;
const TEXT_MAX = 120;

function clean(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, TEXT_MAX) : null;
}

/** Un celular del Perú en «51» + 9 dígitos, o null. */
export function peruMobile(value: unknown): string | null {
  const digits = (clean(value) ?? "").replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) return `51${digits}`;
  if (digits.length === 11 && digits.startsWith("519")) return digits;
  return null;
}

/** El número de pedido que aparezca en un texto («#KP143754»), normalizado. */
export function orderNameIn(text: string | null | undefined): string | null {
  const m = (text ?? "").match(ORDER_NAME);
  return m ? `#${m[1]!.toUpperCase()}${m[2]}` : null;
}

/**
 * Destinatario, celular y referencia de la respuesta de `GET /v2/guias/<n>`,
 * buscados por el nombre de los campos hasta tres niveles. Un número de pedido
 * escrito en cualquier campo gana como referencia.
 */
export function swaypGuideContact(guide: unknown): SwaypGuideContact {
  const out: SwaypGuideContact = { name: null, phone: null, reference: null };
  let orderName: string | null = null;
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        visit(value, depth + 1);
        continue;
      }
      const text = clean(value);
      if (!text) continue;
      orderName ??= orderNameIn(text);
      if (!out.phone && PHONE_KEY.test(key)) out.phone = peruMobile(text);
      if (!out.name && NAME_KEY.test(key) && !/\d{6,}/.test(text) && !/(usuario|empresa|remitente|courier|producto|item|articulo|art[ií]culo|sku|bodega|almacen|ciudad|distrito)/i.test(key)) {
        out.name = text;
      }
      if (!out.reference && REFERENCE_KEY.test(key)) out.reference = text;
    }
  };
  visit(guide, 0);
  if (orderName) out.reference = orderName;
  return out;
}

/** Tope para preguntarle a Swayp por la guía: el webhook no espera más. */
const FETCH_GUIDE_TIMEOUT_MS = 4_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deja constancia de un aviso de Swayp sobre una guía que Kapta no tiene. La
 * primera vez le pregunta a Swayp por la guía (con tope de 4 s) para sugerir el
 * pedido; las siguientes solo suben la cuenta, la hora y el estado. Nunca
 * lanza: el webhook responde igual.
 */
export async function recordUnknownSwaypGuide(
  admin: SupabaseClient,
  input: {
    guideNumber: string;
    state: number;
    orgId: string | null;
    now?: Date;
    fetchGuide?: ((guideNumber: string) => Promise<unknown>) | null;
  },
): Promise<"nueva" | "repetida" | "error"> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const { data: existing, error: readError } = await admin
      .from("swayp_unknown_guides")
      .select("guide_number,notices")
      .eq("guide_number", input.guideNumber)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (existing) {
      const notices = Number((existing as { notices?: number }).notices ?? 1) + 1;
      const { error } = await admin
        .from("swayp_unknown_guides")
        .update({ last_seen_at: nowIso, last_state: input.state, notices })
        .eq("guide_number", input.guideNumber);
      if (error) throw new Error(error.message);
      return "repetida";
    }

    let contact: SwaypGuideContact = { name: null, phone: null, reference: null };
    if (input.fetchGuide) {
      try {
        const guide = await withTimeout(input.fetchGuide(input.guideNumber), FETCH_GUIDE_TIMEOUT_MS);
        if (guide) contact = swaypGuideContact(guide);
      } catch {
        /* sin datos de la guía: se guarda solo el número */
      }
    }
    const { error } = await admin.from("swayp_unknown_guides").insert({
      guide_number: input.guideNumber,
      org_id: input.orgId,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      last_state: input.state,
      notices: 1,
      customer_name: contact.name,
      customer_phone: contact.phone,
      reference: contact.reference,
    });
    if (error) {
      // Dos avisos a la vez: el otro ya la guardó.
      if ((error as { code?: string }).code === "23505") return "repetida";
      throw new Error(error.message);
    }
    return "nueva";
  } catch (cause) {
    console.error(
      `[swayp-webhook] ${JSON.stringify({
        paso: "guia_desconocida",
        guia: input.guideNumber,
        error: cause instanceof Error ? cause.message : String(cause),
      })}`,
    );
    return "error";
  }
}
