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
  /**
   * Últimos 3 dígitos de su celular. `null` cuando la cuenta NO TIENE celular:
   * la pasarela Flow cobra como «Aurela Kenku» y su comprobante no muestra
   * ninguno. Ahí la única señal es el nombre, y un celular leído la desmiente.
   */
  phoneLastDigits: string | null;
}

/** ¿La cuenta cobra con celular (Yape, Plin) o sin él (una pasarela)? */
function accountHasPhone(account: CollectionAccount): account is CollectionAccount & {
  phoneLastDigits: string;
} {
  return typeof account.phoneLastDigits === "string";
}

/**
 * Las cuentas con las que se puede contrastar. Una mal cargada —sin nombre, o
 * con un celular que no son tres dígitos— no cuenta como cuenta. Sin celular
 * sí vale: es una pasarela, no un dato a medias.
 */
function usableAccounts(accounts: CollectionAccount[]): CollectionAccount[] {
  return accounts.filter(
    (a) => a.name.trim() && (!accountHasPhone(a) || /^\d{3}$/.test(a.phoneLastDigits)),
  );
}

/** Cómo se nombra una cuenta en un aviso: «Grupo GF S.A.C. · ···309». */
export function describeCollectionAccount(account: CollectionAccount): string {
  return accountHasPhone(account)
    ? `${account.name} · ···${account.phoneLastDigits}`
    : `${account.name} · sin celular`;
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
  /**
   * La lectura vino con el pagador y el receptor intercambiados, y se corrigió.
   *
   * Se expone en vez de corregirse en silencio: esta comprobación decide si el
   * dinero se desvió, y arreglar un dato callando que estaba mal es justo lo que
   * no puede hacer. Quien valida tiene que saber que el nombre que ve salió del
   * otro campo.
   */
  swapped: boolean;
  /**
   * El nombre que el lector dio como receptor y NO cuenta, porque es el de la
   * clienta del pedido: casi siempre la nota que ella escribe en el Yape
   * («sonia ludeña»). `name` queda en null y la cuenta se juzga por el celular.
   * Ver `nameIsTheCustomers`.
   *
   * Se expone por la misma razón que `swapped`: descartar una lectura en
   * silencio es justo lo que esta comprobación no puede hacer.
   */
  ignoredName: string | null;
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
 * Separa el final del celular que algunas apps pegan al nombre del receptor.
 *
 * La app del BBVA, al pagar a un Yape desde «Envío a contactos», escribe el
 * contacto como «Grupo gf s •5309»: el nombre recortado y, tras un punto, los
 * últimos cuatro dígitos del celular. Leído como nombre, «5309» es una palabra
 * que no pertenece a Grupo GF S.A.C. y el cobro salía acusado de ir a otra
 * cuenta —#KP137040 y otros dos cobros del courier—. Plin hace lo mismo con el
 * número entero: «Grupo Gf S · 930 555 309 - Yape».
 *
 * Esos dígitos no se tiran: son el CELULAR, la señal tajante. Se devuelven
 * aparte para que se juzguen como celular.
 *
 * Solo corta tras un separador de los que usan las apps (•, ·, ∙, *): un nombre
 * que simplemente termina en números no se toca.
 */
export function splitRecipientPhoneSuffix(raw: string | null | undefined): {
  name: string | null;
  phoneDigits: string | null;
} {
  const value = raw?.trim() ?? "";
  if (!value) return { name: null, phoneDigits: null };
  const m = /^(.*?\S)\s*[•·∙*]+\s*((?:\d\s*){3,}?)\s*(?:-\s*(?:yape|plin)\s*)?$/i.exec(value);
  if (!m) return { name: value, phoneDigits: null };
  return { name: m[1]!.trim(), phoneDigits: m[2]!.replace(/\s/g, "") };
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
  const phoneMatches =
    accountHasPhone(account) && hasPhone && phone.endsWith(account.phoneLastDigits);

  // Solo DESMIENTE lo que contradice. Una lectura incompleta no es una
  // contradicción, y el celular sigue siendo tajante: leído y sin terminar en
  // los dígitos de la cuenta, es otra cuenta, sin matices. Contra una cuenta
  // SIN celular —la pasarela— cualquier celular leído es otra cuenta: su
  // comprobante no enseña ninguno.
  const nameContradicts = hasName && !nameMatches && !nameCutShort;
  const phoneContradicts = hasPhone && !phoneMatches;

  // Una pasarela no tiene segunda señal que esperar: su nombre entero es todo lo
  // que su comprobante puede decir de la cuenta, y con él queda verificada.
  const phoneSettled = phoneMatches || !accountHasPhone(account);

  let status: YapeRecipientCheck = "missing";
  if (nameContradicts || phoneContradicts) status = "mismatch";
  else if (nameMatches && phoneSettled) status = "verified";
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

  const usable = usableAccounts(accounts);
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
 * ¿La lectura trae el pagador y el receptor cambiados de sitio?
 *
 * Pasó de verdad: en un comprobante de S/ 212 el lector puso «Grupo Gf S.a.c.»
 * —nuestra cuenta— en `payer_name`, y el nombre de la clienta en
 * `recipient_name`. La alarma saltó como «Receptor distinto», que es la etiqueta
 * más grave que hay, sobre un cobro impecable.
 *
 * La pista de cómo ocurre está en que el CELULAR sí lo leyó bien: encontró el
 * bloque del receptor, sacó de ahí el teléfono, y para el nombre se fue a otro
 * bloque. Compone la respuesta campo por campo en vez de por bloques.
 *
 * LA REGLA EXIGE LAS DOS PUNTAS, y no es escrúpulo: pedir solo que el pagador
 * sea una cuenta nuestra rompería los reembolsos, donde SÍ somos el pagador
 * legítimamente. Nadie puede ser las dos puntas del mismo Yape, así que la
 * contradicción —pagador nuestro Y celular receptor nuestro— es lo que la
 * delata. Si el celular no se leyó, no se puede afirmar nada y no se toca.
 *
 * Se exige además que el nombre del pagador encaje ENTERO con una cuenta. Una
 * lectura corta o enmascarada no basta para dar por invertido un comprobante.
 */
export function readingLooksSwapped(
  payerName: string | null | undefined,
  recipientPhone: string | null | undefined,
  accounts: CollectionAccount[],
): boolean {
  if (!payerName?.trim()) return false;
  const payerIsOurs = verifyYapeRecipient(payerName, null, accounts).nameMatches;
  if (!payerIsOurs) return false;
  return verifyYapeRecipient(null, recipientPhone, accounts).phoneMatches;
}

/**
 * ¿El nombre leído como receptor es el de la CLIENTA del pedido?
 *
 * Yape deja que quien paga escriba un mensaje, y la captura lo pinta justo
 * debajo del receptor. Muchas clientas escriben ahí su propio nombre para que
 * sepamos de quién es el pago, y el lector lo copia como destinatario:
 * #AUR177541 salió «sonia ludeña» —la clienta es SONIA IBETH LUDEÑA QUISPE—
 * con el celular ···309 de la empresa, y quedó acusado de desvío. #AUR177034,
 * el que se había dado por «nombre ajeno con nuestro celular», era lo mismo:
 * «Rosa campos Mendoza» es ROSA LUZ CAMPOS MENDOZA, la clienta.
 *
 * Aquí el orden de las palabras NO importa, y es a propósito. La comparación
 * con las cuentas lo exige porque de ella sale «el dinero es nuestro»; esta
 * solo reconoce a la clienta, y la gente escribe su nombre como le sale
 * («Ludeña Sonia»). Se piden dos palabras, todas del nombre de la clienta: un
 * nombre de pila suelto no distingue a nadie.
 */
export function nameIsTheCustomers(
  readName: string | null | undefined,
  customerName: string | null | undefined,
): boolean {
  const read = words(comparableRecipientName(readName));
  const pool = words(comparableRecipientName(customerName));
  if (read.length < 2 || pool.length < 2) return false;
  for (const word of read) {
    const at = pool.indexOf(word);
    if (at < 0) return false;
    pool.splice(at, 1);
  }
  return true;
}

/** Lo que el lector dijo de las dos puntas del pago. */
export interface YapeRecipientRawReading {
  recipientName: string | null | undefined;
  recipientPhoneLastDigits: string | null | undefined;
  payerName: string | null | undefined;
}

/**
 * Juzga la cuenta receptora a partir de lo que el lector dijo, con las dos
 * correcciones aplicadas y DICHAS: la lectura invertida (`swapped`) y el nombre
 * de la clienta tomado por receptor (`ignoredName`).
 *
 * Es la única definición: la usan la carga (`voucherReading`) y cada pantalla
 * que relee la auditoría (`yapeRecipientReadingFromVision`). Dos copias de esta
 * regla acabarían discrepando sobre si el dinero se desvió.
 */
export function yapeRecipientReading(
  read: YapeRecipientRawReading,
  accounts: CollectionAccount[],
  customerName?: string | null,
): YapeRecipientReading {
  // «Grupo gf s •5309» (BBVA): el final del celular viene pegado al nombre. Se
  // separa y es EL celular: sale del mismo bloque que el receptor, así que manda
  // sobre uno leído aparte, que pudo salir de otra parte de la pantalla.
  const split = splitRecipientPhoneSuffix(read.recipientName);
  const name = split.name;
  const digits = (split.phoneDigits || read.recipientPhoneLastDigits || "").replace(/\D/g, "");
  const phoneLastDigits = digits.length >= 3 ? digits.slice(-3) : null;
  const payerName = read.payerName?.trim() || null;

  // La corrección va AQUÍ, donde todo se recalcula, y no en la carga: así los
  // comprobantes ya guardados con la lectura invertida se arreglan solos, sin
  // backfill, igual que se arreglaron los del nombre recortado.
  const swapped = readingLooksSwapped(payerName, phoneLastDigits, accounts);
  const effectiveName = swapped ? payerName : name;

  let verification = verifyYapeRecipient(effectiveName, phoneLastDigits, accounts);

  // EL NOMBRE DE LA CLIENTA NO ES EL RECEPTOR. Si el celular receptor es de una
  // cuenta nuestra y el nombre leído es el de la clienta, ese nombre salió de
  // otro sitio —la nota del Yape, o el pagador—: nadie es las dos puntas del
  // mismo pago. Se descarta y la cuenta se juzga por el celular, que la deja en
  // `partial` —contraste manual—, nunca en `verified`.
  //
  // Exige LAS DOS PUNTAS, como la inversión. Sin el celular nuestro, el nombre
  // de la clienta como receptor es justo la forma de un pago que ella se hizo a
  // sí misma, y eso sí tiene que seguir saltando.
  let ignoredName: string | null = null;
  if (
    verification.status === "mismatch" &&
    nameIsTheCustomers(effectiveName, customerName) &&
    verifyYapeRecipient(null, phoneLastDigits, accounts).phoneMatches
  ) {
    ignoredName = effectiveName;
    verification = verifyYapeRecipient(null, phoneLastDigits, accounts);
  }

  return {
    name: ignoredName ? null : effectiveName,
    phoneLastDigits,
    status: verification.status,
    account: verification.account,
    swapped,
    ignoredName,
  };
}

/**
 * Lee la auditoría JSON guardada con cada comprobante sin confiar en su estado.
 *
 * El `recipient_check` que hay dentro del jsonb se escribió el día de la carga,
 * con las cuentas y las reglas de ese día. Aquí se RECALCULA: es la única forma
 * de que arreglar la regla arregle también lo ya cargado.
 *
 * `customerName` es el nombre de la clienta del pedido. Sin él la regla sigue
 * en pie, solo que no puede reconocer su nombre en la nota del Yape.
 */
export function yapeRecipientReadingFromVision(
  vision: unknown,
  accounts: CollectionAccount[],
  customerName?: string | null,
): YapeRecipientReading {
  const root = vision && typeof vision === "object" ? vision as Record<string, unknown> : {};
  const extracted = root.extracted && typeof root.extracted === "object"
    ? root.extracted as Record<string, unknown>
    : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return yapeRecipientReading(
    {
      recipientName: text(extracted.recipient_name),
      recipientPhoneLastDigits: text(extracted.recipient_phone_last_digits),
      payerName: text(extracted.payer_name),
    },
    accounts,
    customerName,
  );
}

/**
 * QUÉ señal desmintió la cuenta, dicho para quien tiene el comprobante delante.
 *
 * El aviso decía «el destinatario o el celular receptor leído no coincide», y
 * ese «o» es el problema: quien revisa no sabe cuál de los dos mirar. En
 * #KP126085 el celular ···309 SÍ era la cuenta de la empresa y lo único
 * equivocado era una palabra —el lector puso «Cerdo Gf S.a.c.» por «Grupo Gf
 * S.a.c.»—, pero el mensaje presentaba las dos señales como igual de dudosas.
 * El comprobante llevaba siete semanas parado.
 *
 * Distinguirlo importa porque las dos formas de fallar son casos distintos:
 *
 *   · Celular nuestro y nombre que no encaja → casi siempre lectura mala —una
 *     palabra mal leída, o el mensaje que escribió quien pagó—, pero también es
 *     la forma que tendría un comprobante ajeno con nuestro número delante. Hay
 *     que mirar. (Cuando ese nombre es el de la clienta ya no llega aquí: ver
 *     `nameIsTheCustomers`.)
 *   · Celular que no es de ninguna cuenta → eso sí es tajante.
 *
 * Devuelve null cuando no hay nada que desmentir.
 */
export function motivoDelDesencuentro(
  reading: YapeRecipientReading,
  accounts: CollectionAccount[],
): string | null {
  if (reading.status !== "mismatch") return null;

  const usable = usableAccounts(accounts);
  const lista = usable.length
    ? usable.map(describeCollectionAccount).join(" / ")
    : "ninguna cuenta de cobro configurada";

  const celularNuestro = usable.filter(accountHasPhone).find(
    (a) => reading.phoneLastDigits && reading.phoneLastDigits.endsWith(a.phoneLastDigits),
  );

  if (celularNuestro) {
    return (
      `El celular receptor ···${celularNuestro.phoneLastDigits} SÍ es el de ${celularNuestro.name}, ` +
      `pero el nombre leído —«${reading.name ?? "sin nombre"}»— no encaja con esa cuenta. ` +
      "Abre el comprobante: si el nombre en la imagen es el de la cuenta, o es el mensaje que " +
      "escribió quien pagó, fue una lectura mala del lector; si es el de otra persona, el " +
      "comprobante no es nuestro."
    );
  }

  if (reading.phoneLastDigits) {
    return (
      `El celular receptor leído termina en ···${reading.phoneLastDigits}, que no es de ninguna ` +
      `cuenta de cobro (${lista}). Es la señal tajante: contrasta la imagen y rechaza si el dinero ` +
      "se fue a otra cuenta."
    );
  }

  return (
    `El nombre leído —«${reading.name ?? "sin nombre"}»— no encaja con ${lista}, y el comprobante ` +
    "no dejó ver el celular receptor para contrastarlo. Abre la imagen."
  );
}
