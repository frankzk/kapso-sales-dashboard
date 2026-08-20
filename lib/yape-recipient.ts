// ¿El comprobante dice que el dinero llegó a una cuenta nuestra?
//
// Esta era la única regla del sistema con UNA cuenta escrita a mano —«Grupo GF
// S.A.C.» / celular 309— cuando el negocio cobra por varias. Cada comprobante a
// la cuenta de una de las personas dueñas quedaba en `revision_admin`, la
// etiqueta que dice "el dinero se fue a otra cuenta": diecisiete en tres
// semanas, ninguno validado, y todos los pedidos salieron igual. El bloqueo no
// protegía nada; solo enseñaba a no leer la alarma.
//
// Ahora las cuentas llegan de fuera (`store_collection_accounts`, migración
// 0126) y la comparación se hace contra todas: basta con que el comprobante
// encaje con UNA para dejar de acusarlo.

export type YapeRecipientCheck = "verified" | "partial" | "mismatch" | "missing";

/** Una cuenta a la que la tienda puede cobrar legítimamente. */
export interface CollectionAccount {
  /** El nombre tal como lo escribe la app de esa cuenta. */
  name: string;
  /**
   * Otras formas en que la MISMA cuenta aparece escrita. Existe porque el banco
   * y la billetera no coinciden: la constancia bancaria pone los apellidos
   * primero («KASTNER CAM FRANKZ ALBERTO PAOLO») y Yape los pone al final. Es
   * más honesto declarar la otra forma acá que enseñarle a la comparación a
   * ignorar el orden, que la volvería permisiva con cualquier nombre.
   */
  aliases?: string[];
  /** Últimos 3 dígitos de su celular. */
  phoneLastDigits: string;
}

export interface YapeRecipientVerification {
  status: YapeRecipientCheck;
  nameMatches: boolean;
  phoneMatches: boolean;
  hasName: boolean;
  hasPhone: boolean;
  /**
   * El nombre leído no confirma la cuenta, pero tampoco la desmiente: es el
   * nombre esperado recortado o enmascarado. Ver `nameIsCutShort`.
   */
  nameCutShort: boolean;
  /** Con cuál de las cuentas encajó, si encajó con alguna. */
  account: CollectionAccount | null;
  /**
   * La tienda no tiene cuentas configuradas, así que NO SE PUEDE contrastar.
   * Nunca es `mismatch`: un despiste de configuración no es un desvío.
   */
  unknownAccounts: boolean;
}

export interface YapeRecipientReading {
  name: string | null;
  phoneLastDigits: string | null;
  status: YapeRecipientCheck;
  account: CollectionAccount | null;
}

function comparableRecipientName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

/**
 * Alinea el nombre leído contra el esperado, palabra por palabra y EN ORDEN,
 * que es como recorta y enmascara una pantalla.
 *
 * Devuelve cuántas palabras esperadas quedaron cubiertas, si todas se
 * escribieron enteras, y si apareció algo que no pertenece al nombre.
 *
 * Dos cosas que parecen detalles y son los casos reales que más aparecen:
 *
 *   - Una palabra leída puede cubrir VARIAS esperadas cuando la pantalla las
 *     escribe pegadas: «SAC» es «S.A.C.». Sin esto, la lectura más normal que
 *     existe —«Grupo GF SAC»— quedaba acusada de desvío.
 *   - Una palabra leída puede quedarse a medias en CUALQUIER posición, no solo
 *     al final: el enmascarado corta todas a la vez, «Gr*** Gf*** S*** A***
 *     C***». Una lectura así no confirma la cuenta, pero tampoco la desmiente.
 */
function alignName(read: string[], expected: string[]): {
  covered: number;
  complete: boolean;
  foreign: boolean;
} {
  let i = 0; // posición en `expected`
  let covered = 0;
  let everyWordWhole = true;

  for (const word of read) {
    if (i >= expected.length) return { covered, complete: false, foreign: true };

    // ¿Cuántas palabras esperadas escribe esta palabra leída, de corrido?
    let joined = "";
    let eaten = 0;
    while (i + eaten < expected.length && joined.length < word.length) {
      joined += expected[i + eaten]!;
      eaten += 1;
    }
    if (joined === word) {
      // Las escribió enteras.
      i += eaten;
      covered += eaten;
      continue;
    }
    if (joined.startsWith(word)) {
      // Se quedó a mitad de la última: cuenta como cubierta, pero incompleta.
      i += eaten;
      covered += eaten;
      everyWordWhole = false;
      continue;
    }
    // Ni siquiera empieza como lo esperado: es otro nombre.
    return { covered, complete: false, foreign: true };
  }

  return {
    covered,
    complete: everyWordWhole && covered === expected.length,
    foreign: false,
  };
}

/**
 * ¿El nombre leído es el esperado CORTADO, y no el de otra persona?
 *
 * La pantalla recorta el destinatario por ancho —«Grupo Gf S» por «Grupo GF
 * S.A.C.»— y a veces lo enmascara —«Gr*** Gf*** S*** A*** C***»—. Exigir el
 * nombre entero convertía esas lecturas en `mismatch`, que es la etiqueta más
 * grave que hay. Eran ~45 comprobantes acusados de desvío por un nombre que la
 * pantalla no terminó de escribir, con el botón de validar deshabilitado.
 *
 * El daño real no era el atasco sino la costumbre: una alarma que casi siempre
 * miente deja de leerse, y esta tiene que ser creíble el día que aparezca un
 * receptor de verdad distinto —que aparecen, y con nombre propio.
 *
 * Una lectura corta NO verifica la cuenta; solo deja de acusarla. Cae en
 * `partial`, que ya existía y dice lo que toca: contrasta la imagen.
 *
 * Se piden dos palabras: «Grupo» a secas no distingue Grupo GF de cualquier
 * otro Grupo, y «G» no distingue nada en absoluto.
 */
function nameIsCutShort(a: { covered: number; complete: boolean; foreign: boolean }): boolean {
  if (a.foreign || a.complete) return false;
  return a.covered >= 2;
}

function verifyAgainst(
  name: string,
  phone: string,
  hasName: boolean,
  hasPhone: boolean,
  account: CollectionAccount,
): YapeRecipientVerification {
  const read = words(name);
  // Se prueba contra el nombre y sus variantes, y manda la mejor alineación.
  // Las variantes viven en los DATOS y no en la comparación a propósito: la app
  // y el banco escriben a la misma persona en orden distinto —Yape «Frankz
  // Alberto Paolo Kastner», la constancia «KASTNER CAM FRANKZ ALBERTO PAOLO»—.
  // Enseñarle a la comparación a ignorar el orden la volvía permisiva con todo
  // el mundo; escribir la otra forma en la ficha de la cuenta es explícito, lo
  // decide una persona y no afloja nada más.
  let best = { covered: 0, complete: false, foreign: true };
  for (const variant of [account.name, ...(account.aliases ?? [])]) {
    const expected = words(comparableRecipientName(variant));
    if (!expected.length) continue;
    const a = alignName(read, expected);
    const better =
      (a.complete && !best.complete) ||
      (a.complete === best.complete && !a.foreign && (best.foreign || a.covered > best.covered));
    if (better) best = a;
  }

  const nameMatches = hasName && best.complete;
  const nameCutShort = hasName && !nameMatches && nameIsCutShort(best);
  const phoneMatches = hasPhone && phone.endsWith(account.phoneLastDigits);

  // Solo DESMIENTE lo que contradice. Una lectura incompleta no es una
  // contradicción, y el celular sigue siendo tajante: leído y sin terminar en
  // los dígitos de la cuenta, es otra cuenta, sin matices.
  const nameContradicts = hasName && !nameMatches && !nameCutShort;
  const phoneContradicts = hasPhone && !phoneMatches;

  let status: YapeRecipientCheck = "missing";
  if (nameContradicts || phoneContradicts) status = "mismatch";
  else if (nameMatches && phoneMatches) status = "verified";
  else if (nameMatches || phoneMatches || nameCutShort) status = "partial";

  return {
    status,
    nameMatches,
    phoneMatches,
    hasName,
    hasPhone,
    nameCutShort,
    account: status === "verified" || status === "partial" ? account : null,
    unknownAccounts: false,
  };
}

/** Mejor primero: lo que encaja manda sobre lo que desmiente. */
const RANK: Record<YapeRecipientCheck, number> = {
  verified: 3,
  partial: 2,
  missing: 1,
  mismatch: 0,
};

/**
 * Verifica las dos señales visibles de la cuenta receptora contra TODAS las
 * cuentas de cobro de la tienda. Basta encajar con una.
 *
 * Sin cuentas configuradas no se puede juzgar: devuelve `partial` (contraste
 * manual) o `missing`, jamás `mismatch`. Un despiste de configuración no puede
 * convertirse en una acusación de desvío sobre todos los cobros de la tienda.
 */
export function verifyYapeRecipient(
  recipientName: string | null | undefined,
  recipientPhone: string | null | undefined,
  accounts: CollectionAccount[],
): YapeRecipientVerification {
  const name = comparableRecipientName(recipientName);
  const phone = (recipientPhone ?? "").replace(/\D/g, "");
  const hasName = Boolean(name);
  const hasPhone = phone.length >= 3;

  const usable = accounts.filter((a) => a.name.trim() && /^\d{3}$/.test(a.phoneLastDigits));
  if (!usable.length) {
    return {
      status: hasName || hasPhone ? "partial" : "missing",
      nameMatches: false,
      phoneMatches: false,
      hasName,
      hasPhone,
      nameCutShort: false,
      account: null,
      unknownAccounts: true,
    };
  }

  let best: YapeRecipientVerification | null = null;
  for (const account of usable) {
    const v = verifyAgainst(name, phone, hasName, hasPhone, account);
    if (!best || RANK[v.status] > RANK[best.status]) best = v;
  }
  return best!;
}

export function checkYapeRecipient(
  recipientName: string | null | undefined,
  recipientPhone: string | null | undefined,
  accounts: CollectionAccount[],
): YapeRecipientCheck {
  return verifyYapeRecipient(recipientName, recipientPhone, accounts).status;
}

/**
 * Lee la auditoría JSON guardada con cada comprobante sin confiar en su estado.
 *
 * El `recipient_check` que hay dentro del jsonb se escribió el día de la carga,
 * con las cuentas y las reglas de ese día. Aquí se RECALCULA: es la única forma
 * de que arreglar la regla arregle también lo ya cargado.
 */
export function yapeRecipientReadingFromVision(
  vision: unknown,
  accounts: CollectionAccount[],
): YapeRecipientReading {
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
  const verification = verifyYapeRecipient(name, phoneLastDigits, accounts);
  return {
    name,
    phoneLastDigits,
    status: verification.status,
    account: verification.account,
  };
}
