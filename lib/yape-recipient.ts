export type YapeRecipientCheck = "verified" | "partial" | "mismatch" | "missing";

export interface YapeRecipientVerification {
  status: YapeRecipientCheck;
  nameMatches: boolean;
  phoneMatches: boolean;
  hasName: boolean;
  hasPhone: boolean;
  /**
   * El nombre leído no confirma la cuenta, pero tampoco la desmiente: es un
   * comienzo del nombre esperado que se quedó corto. Ver `nameIsCutShort`.
   */
  nameCutShort: boolean;
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

/** «Grupo GF S.A.C.» en las palabras que deja `comparableRecipientName`. */
const EXPECTED_NAME_WORDS = ["grupo", "gf", "s", "a", "c"];

/**
 * ¿El nombre leído es el esperado CORTADO, y no el de otra persona?
 *
 * El voucher recorta el destinatario. Yape y la app de BCP lo truncan por ancho
 * de pantalla —«Grupo Gf S» por «Grupo GF S.A.C.»— y a veces lo enmascaran
 * —«Grupo G***»—. Exigir el sufijo `S.A.C.` convertía esas lecturas en
 * `mismatch`, que es la etiqueta más grave que hay: dice que el dinero se fue a
 * OTRA cuenta. Eran ~45 comprobantes acusados de desvío por un nombre que la
 * pantalla no terminó de escribir, con el botón de validar deshabilitado.
 *
 * El daño real no era el atasco sino la costumbre: una alarma que casi siempre
 * miente deja de leerse, y esta tiene que ser creíble el día que aparezca un
 * receptor de verdad distinto —que aparecen, y con nombre propio.
 *
 * Una lectura corta NO verifica la cuenta; solo deja de acusarla. Cae en
 * `partial`, que ya existía y dice lo que toca: contrasta la imagen.
 *
 * La comparación es por palabras y en orden desde el principio, porque eso es
 * lo que hace un recorte. La última palabra puede venir partida a la mitad
 * («g» por «gf»); las anteriores tienen que estar completas. Se exigen dos
 * palabras: «grupo» a secas no distingue nada.
 */
function nameIsCutShort(name: string): boolean {
  const words = name.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > EXPECTED_NAME_WORDS.length) return false;
  return words.every((word, i) => {
    const expected = EXPECTED_NAME_WORDS[i];
    if (!expected) return false;
    return i === words.length - 1 ? expected.startsWith(word) : word === expected;
  });
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
  const nameCutShort = hasName && !nameMatches && nameIsCutShort(name);

  // Solo DESMIENTE lo que contradice. Una lectura incompleta no es una
  // contradicción, y el celular sigue siendo tajante: leído y sin terminar en
  // 309 es otra cuenta, sin matices.
  const nameContradicts = hasName && !nameMatches && !nameCutShort;
  const phoneContradicts = hasPhone && !phoneMatches;

  let status: YapeRecipientCheck = "missing";
  if (nameContradicts || phoneContradicts) status = "mismatch";
  else if (nameMatches && phoneMatches) status = "verified";
  else if (nameMatches || phoneMatches || nameCutShort) status = "partial";

  return { status, nameMatches, phoneMatches, hasName, hasPhone, nameCutShort };
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
