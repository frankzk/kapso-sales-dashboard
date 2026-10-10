// «Cotejar Shalom»: de qué pedido de Kapta es cada guía que una persona creó a
// mano en pro.shalom.pe y nunca registró en Kapta (MOM §12). PURO Y TESTEADO:
// ni red ni base. La lectura y la escritura están en account-cotejo.ts.
//
// EL HUECO. Al 10-10-2026 había 30 pedidos pagados enteros en «Preparación ·
// Por generar rótulo» sin ninguna salida, casi todos con «shalom …» en la nota o
// con el DNI apuntado: la guía se hizo en Shalom Pro y no se vinculó. Sin la
// guía en Kapta no hay rastreo, ni avisos, ni clave que entregar, y el pedido se
// queda parado para siempre aunque la clienta ya lo haya recogido.
//
// SOLO SE VINCULA LO QUE NO ADMITE DUDA. Una guía en el pedido equivocado mueve
// el estado de OTRO pedido y le avisa a OTRA clienta. Igual que Cotejar Olva:
//
//   1. MISMO DNI. El documento del destinatario de la guía es el que se apuntó
//      para el envío («DNI y agencia» del panel de pagos, `shalom_order_drafts`).
//   2. MISMO CELULAR Y UN NOMBRE EN COMÚN. Los 9 dígitos del celular del pedido
//      y al menos un nombre (de 3 letras o más) del destinatario de Shalom.
//
// Y en los dos, una pareja única dentro de la ventana de fechas —la guía creada
// entre un día antes y 45 días después del pedido—:
//
//   - De las guías SIN vincular, solo UNA tiene el DNI o el celular del pedido.
//     Que haya otra «parecida» (mismo celular y otro nombre, por ejemplo) ya es
//     duda.
//   - Ningún OTRO pedido de Kapta —esté como esté, cerrado o anulado incluidos—
//     tiene ese DNI o ese celular con la guía dentro de su ventana. La misma
//     clienta con dos pedidos no se adivina.
//   - Una guía que ya está en una salida de Kapta no se toca: es de ese pedido.
//
// Lo demás queda para una persona, con el motivo.

import { phoneKey } from "@/lib/olva/email-label";
import { normalizeText } from "@/lib/olva/portal-match";
import type { ShalomAccountOrder } from "@/lib/shalom/types";

const DAY_MS = 86_400_000;
/** La guía puede llevar fecha de la víspera: zona horaria del listado. */
export const WINDOW_BEFORE_DAYS = 1;
/**
 * Medido sobre las 1.950 guías creadas desde Kapta: el 99 % sale en 10 días
 * del pedido, y las que tardan es porque el pago llegó tarde. 45 días cubre
 * esas sin juntar en la ventana dos pedidos de la misma clienta.
 */
export const WINDOW_AFTER_DAYS = 45;
/** Un nombre más corto («de», «la») no identifica a nadie. */
const MIN_NAME_TOKEN = 3;
/** Un documento más corto no identifica a nadie. El DNI son 8. */
const MIN_DOCUMENT = 8;

/** Una guía del listado de la cuenta, con lo que hace falta para cotejarla. */
export interface ShalomListingGuide {
  guia: string;
  codigo: string | null;
  serie: string | null;
  /** `id` del listado. Es el OSE ID solo si se comprueba (ose-backfill.ts). */
  listingId: number | null;
  createdAt: string | null;
  document: string | null;
  /** Los 9 dígitos, sin el 51. */
  phone: string | null;
  name: string | null;
}

/** Un pedido de Kapta: un candidato a vincular, o alguien que podría discutirlo. */
export interface CotejoShalomOrder {
  orderId: string;
  storeId: string;
  orderName: string | null;
  createdAt: string | null;
  customerName: string | null;
  /** Los 9 dígitos, sin el 51. */
  phone: string | null;
  /** El documento apuntado para el envío (`shalom_order_drafts`). */
  document: string | null;
  /**
   * true → pagado, en «Por generar rótulo» y sin salida viva: se le busca
   * guía. false → otro pedido de la misma clienta, que solo puede estorbar.
   */
  candidate: boolean;
}

export type ShalomCotejoVia = "dni" | "telefono";

export type ShalomCotejoOutcome =
  | { kind: "vincular"; order: CotejoShalomOrder; guide: ShalomListingGuide; via: ShalomCotejoVia }
  | { kind: "ambiguo"; order: CotejoShalomOrder; reason: string; guias: string[] }
  | { kind: "sin_pareja"; order: CotejoShalomOrder };

/** Qué campos del listado se comprobó que son del destinatario. */
export interface UsableFields {
  documento: boolean;
  telefono: boolean;
}

export function documentKey(raw: unknown): string | null {
  const v = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length >= MIN_DOCUMENT ? v : null;
}

export function guideCodeKey(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

function receiverName(r: NonNullable<ShalomAccountOrder["receiver"]>): string | null {
  const full = (r.full_name ?? "").trim();
  if (full) return full;
  const parts = [r.name, r.last_name, r.sur_name].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** Lee una orden del listado. Sin número de guía no hay nada que vincular. */
export function readListingGuide(o: ShalomAccountOrder): ShalomListingGuide | null {
  const guia = guideCodeKey(o.guia);
  if (!guia) return null;
  const r = o.receiver ?? null;
  return {
    guia,
    codigo: (o.codigo ?? "").trim() || null,
    serie: (o.serie ?? "").trim() || null,
    listingId: Number.isSafeInteger(o.id) && o.id > 0 ? o.id : null,
    createdAt: (o.created_at ?? "").trim() || null,
    document: r ? documentKey(r.document) : null,
    phone: r ? phoneKey(String(r.phone ?? "")) : null,
    name: r ? receiverName(r) : null,
  };
}

function nameTokens(name: string | null | undefined): Set<string> {
  return new Set(
    normalizeText(name)
      .split(" ")
      .filter((t) => t.length >= MIN_NAME_TOKEN && !/^\d+$/.test(t)),
  );
}

/** ¿Comparten al menos un nombre de verdad? */
export function shareAName(a: string | null | undefined, b: string | null | undefined): boolean {
  const other = nameTokens(b);
  for (const t of nameTokens(a)) if (other.has(t)) return true;
  return false;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * ¿La guía cae en la ventana del pedido? Sin fecha en cualquiera de los dos
 * lados se contesta que SÍ: para decidir quién más podría ser el dueño, no
 * saber es no poder descartarlo.
 */
export function guideInOrderWindow(order: Pick<CotejoShalomOrder, "createdAt">, guide: Pick<ShalomListingGuide, "createdAt">): boolean {
  const o = ms(order.createdAt);
  const g = ms(guide.createdAt);
  if (o === null || g === null) return true;
  return g >= o - WINDOW_BEFORE_DAYS * DAY_MS && g <= o + WINDOW_AFTER_DAYS * DAY_MS;
}

/** Mismo DNI o mismo celular: podría ser su guía, aunque falte confirmarlo. */
function couldBeTheirs(order: CotejoShalomOrder, guide: ShalomListingGuide): boolean {
  if (order.document && guide.document && order.document === guide.document) return true;
  return Boolean(order.phone && guide.phone && order.phone === guide.phone);
}

/** Los dos lados tienen documento y no es el mismo: es otra persona. */
function otherDocument(order: CotejoShalomOrder, guide: ShalomListingGuide): boolean {
  return Boolean(order.document && guide.document && order.document !== guide.document);
}

/** La identidad que de verdad vincula, con los campos que se comprobó usar. */
function exactVia(order: CotejoShalomOrder, guide: ShalomListingGuide, usable: UsableFields): ShalomCotejoVia | null {
  if (usable.documento && order.document && guide.document && order.document === guide.document) return "dni";
  if (
    usable.telefono &&
    order.phone &&
    guide.phone &&
    order.phone === guide.phone &&
    // Mismo celular con OTRO DNI es la madre y la hija que comparten teléfono
    // y apellido: el nombre en común no lo arregla.
    !otherDocument(order, guide) &&
    shareAName(order.customerName, guide.name)
  ) {
    return "telefono";
  }
  return null;
}

/** Por qué una guía «parecida» no basta, dicho para quien la va a revisar. */
function whyNotExact(order: CotejoShalomOrder, guide: ShalomListingGuide, usable: UsableFields): string {
  const samePhone = Boolean(order.phone && guide.phone === order.phone);
  if (samePhone && otherDocument(order, guide)) return "mismo celular, pero otro DNI";
  if (samePhone && usable.telefono && !shareAName(order.customerName, guide.name)) {
    return `mismo celular, pero el destinatario de Shalom es «${guide.name ?? "sin nombre"}»`;
  }
  return "el dato que coincide no se pudo comprobar en el listado";
}

function label(o: CotejoShalomOrder): string {
  return o.orderName ?? o.orderId;
}

/**
 * Coteja los pedidos candidatos contra el listado de la cuenta.
 *
 * @param orders  los candidatos y TODOS los demás pedidos de Kapta con el DNI
 *                o el celular de alguna guía en juego: son los que pueden
 *                discutir una pareja.
 * @param linked  números de guía que ya están en una salida de Kapta.
 * @param usable  qué campos del destinatario se comprobó que son fiables.
 */
export function matchShalomListing(
  guides: readonly ShalomListingGuide[],
  orders: readonly CotejoShalomOrder[],
  linked: ReadonlySet<string>,
  usable: UsableFields,
): ShalomCotejoOutcome[] {
  // La misma guía dos veces en el listado cuenta una vez; si las dos copias no
  // dicen lo mismo del destinatario, cuentan como dos y la pareja se cae sola.
  const seen = new Set<string>();
  const free: ShalomListingGuide[] = [];
  for (const g of guides) {
    if (linked.has(g.guia)) continue;
    const key = `${g.guia}|${g.document ?? ""}|${g.phone ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    free.push(g);
  }

  return orders
    .filter((o) => o.candidate)
    .map((order): ShalomCotejoOutcome => {
      if (!order.createdAt || (!order.document && !order.phone)) return { kind: "sin_pareja", order };

      const possible = free.filter((g) => couldBeTheirs(order, g) && guideInOrderWindow(order, g));
      if (!possible.length) return { kind: "sin_pareja", order };
      const guias = possible.map((g) => g.guia);
      if (possible.length > 1) {
        return { kind: "ambiguo", order, reason: `${possible.length} guías de Shalom podrían ser de este pedido.`, guias };
      }

      const guide = possible[0]!;
      const via = exactVia(order, guide, usable);
      if (!via) {
        return {
          kind: "ambiguo",
          order,
          reason: `La guía ${guide.guia} se parece: ${whyNotExact(order, guide, usable)}.`,
          guias,
        };
      }
      if (!guide.createdAt) {
        return { kind: "ambiguo", order, reason: `La guía ${guide.guia} no trae fecha en el listado.`, guias };
      }

      const rivals = orders.filter(
        (o) => o.orderId !== order.orderId && couldBeTheirs(o, guide) && guideInOrderWindow(o, guide),
      );
      if (rivals.length) {
        return {
          kind: "ambiguo",
          order,
          reason: `La guía ${guide.guia} también podría ser de ${rivals.slice(0, 3).map(label).join(", ")}.`,
          guias,
        };
      }
      return { kind: "vincular", order, guide, via };
    });
}

// ---------------------------------------------------------------------------
// Lo que se comprueba en cada lectura antes de creerse el listado
// ---------------------------------------------------------------------------

/** Una guía creada por API: Kapta sabe a quién iba. */
export interface KnownApiGuide {
  guideCode: string;
  /** El documento apuntado en el pedido (`shalom_order_drafts`). */
  document: string | null;
  /** Los 9 dígitos del celular del pedido. */
  phone: string | null;
}

export interface FieldCheck {
  comparadas: number;
  coinciden: number;
  confiable: boolean;
}

export interface ListingContract {
  documento: FieldCheck;
  telefono: FieldCheck;
}

/** Con menos guías conocidas que esto no hay muestra para fiarse. */
export const CONTRACT_MIN_COMPARED = 10;
/** Nueve de cada diez: el DNI o el celular se pueden corregir después de crear. */
export const CONTRACT_MIN_AGREEMENT = 0.9;

function fieldCheck(pairs: [string | null, string | null][]): FieldCheck {
  const compared = pairs.filter(([a, b]) => a && b);
  const coinciden = compared.filter(([a, b]) => a === b).length;
  return {
    comparadas: compared.length,
    coinciden,
    confiable:
      compared.length >= CONTRACT_MIN_COMPARED && coinciden / compared.length >= CONTRACT_MIN_AGREEMENT,
  };
}

/**
 * ¿El destinatario del listado es de verdad el destinatario?
 *
 * El contrato declara `receiver`, pero nunca se ha visto una respuesta real
 * desde Kapta: podría no venir, venir vacío o ser el remitente. Así que se
 * comprueba en CADA lectura con las guías que Kapta creó por API, de las que
 * sabe el DNI y el celular de la clienta. Si nueve de cada diez no coinciden,
 * ese campo no se usa para vincular. Es el mismo criterio que el OSE ID de las
 * guías manuales (ose-backfill.ts).
 */
export function checkListingContract(
  guides: readonly ShalomListingGuide[],
  known: readonly KnownApiGuide[],
): ListingContract {
  const byGuia = new Map<string, ShalomListingGuide>();
  for (const g of guides) if (!byGuia.has(g.guia)) byGuia.set(g.guia, g);
  const docs: [string | null, string | null][] = [];
  const phones: [string | null, string | null][] = [];
  for (const k of known) {
    const g = byGuia.get(guideCodeKey(k.guideCode));
    if (!g) continue;
    docs.push([k.document, g.document]);
    phones.push([k.phone, g.phone]);
  }
  return { documento: fieldCheck(docs), telefono: fieldCheck(phones) };
}

export interface ListingCoverage {
  esperadas: number;
  encontradas: number;
  completo: boolean;
}

/** De las guías de la API que deberían estar, cuántas tienen que aparecer. */
export const COVERAGE_MIN = 0.97;

/**
 * ¿El listado está ENTERO? Se mide con las guías creadas por API en el
 * periodo: si falta más del 3 %, se cortó (paginación, un tope de `per_page`
 * que Shalom no avisa, un `from` mal leído) y lo que no vino podría ser
 * justo la otra guía que haría dudar. Entonces no se vincula nada.
 */
export function listingCoverage(guides: readonly ShalomListingGuide[], expected: readonly string[]): ListingCoverage {
  const have = new Set(guides.map((g) => g.guia));
  const wanted = [...new Set(expected.map(guideCodeKey).filter(Boolean))];
  const encontradas = wanted.filter((g) => have.has(g)).length;
  return {
    esperadas: wanted.length,
    encontradas,
    completo: wanted.length > 0 && encontradas / wanted.length >= COVERAGE_MIN,
  };
}

export interface CollectedListing {
  orders: ShalomAccountOrder[];
  paginas: number;
  completo: boolean;
  motivo: string | null;
}

/**
 * Baja el listado página a página hasta la última. Shalom no dice cuántas hay:
 * se para cuando una viene con menos de `perPage`, cuando una repite lo ya
 * visto (el wrapper ignoró `page`) o cuando se acaba el tiempo o el tope.
 * Las tres últimas dejan el listado incompleto, y quien llama no vincula.
 */
export async function collectListingPages(
  fetchPage: (page: number, timeoutMs: number) => Promise<ShalomAccountOrder[]>,
  opts: { perPage: number; maxPages: number; deadlineMs: number; now?: () => number },
): Promise<CollectedListing> {
  const now = opts.now ?? Date.now;
  const orders: ShalomAccountOrder[] = [];
  const ids = new Set<string>();
  for (let page = 1; page <= opts.maxPages; page += 1) {
    const left = opts.deadlineMs - now();
    if (left < 5_000) return { orders, paginas: page - 1, completo: false, motivo: "se acabó el tiempo de la pasada" };
    const batch = await fetchPage(page, left);
    const fresh = batch.filter((o) => {
      const key = `${o.id}|${String(o.guia ?? "")}`;
      if (ids.has(key)) return false;
      ids.add(key);
      return true;
    });
    if (batch.length && !fresh.length) {
      return { orders, paginas: page, completo: false, motivo: `la página ${page} repite la anterior: el listado no pagina` };
    }
    orders.push(...fresh);
    if (batch.length < opts.perPage) return { orders, paginas: page, completo: true, motivo: null };
  }
  return { orders, paginas: opts.maxPages, completo: false, motivo: `más de ${opts.maxPages} páginas` };
}

/** Horas de Lima en que el cron coteja: cuatro al día, en la pasada en punto. */
export const COTEJO_HORAS_LIMA = [8, 12, 16, 20] as const;

/**
 * ¿Toca cotejar en esta pasada? El listado entero cuesta: cada página hace que
 * el wrapper baje la cuenta completa de Shalom, y el cupo de 60 llamadas por
 * minuto es de todas las tiendas. Con cuatro veces al día sobra para pedidos
 * que llevan semanas parados. `forzar` es el `?cotejar=1` del cron.
 */
export function shouldRunShalomCotejo(now: Date, forzar: boolean): boolean {
  if (forzar) return true;
  const limaHour = (now.getUTCHours() + 24 - 5) % 24;
  return (COTEJO_HORAS_LIMA as readonly number[]).includes(limaHour) && now.getUTCMinutes() < 30;
}
