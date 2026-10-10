// «Cotejar Shalom» (MOM §12): vincula a su pedido las guías que una persona
// creó a mano en pro.shalom.pe y nunca registró en Kapta. Lo corre el cron de
// Shalom (`/api/cron/shalom-reconcile`) cuatro veces al día.
//
// Qué es una pareja segura lo decide lib/shalom/account-match.ts, puro y con
// pruebas. Aquí solo está el viaje: leer los candidatos, bajar el listado de la
// cuenta, comprobar que el listado está entero y que su destinatario es el
// destinatario, y registrar la guía por el MISMO camino que el drawer
// (lib/shalom/register-guide.ts), sin usuario: `actor` nulo y la nota que dice
// que la registró Cotejar Shalom.
//
// SERVER-ONLY: usa el cliente admin y la sesión de Shalom Pro de la tienda.

import type { SupabaseClient } from "@supabase/supabase-js";
import { phoneKey } from "@/lib/olva/email-label";
import { agencyPaymentReady } from "@/lib/order-macro-stage";
import { isFillableRouteOutput } from "@/lib/shipment-output";
import {
  checkListingContract,
  collectListingPages,
  documentKey,
  guideCodeKey,
  listingCoverage,
  matchShalomListing,
  readListingGuide,
  WINDOW_AFTER_DAYS,
  type CotejoShalomOrder,
  type KnownApiGuide,
  type ListingContract,
  type ListingCoverage,
  type ShalomCotejoVia,
  type ShalomListingGuide,
} from "@/lib/shalom/account-match";
import { describeShalomError, SLOW_TIMEOUT_MS } from "@/lib/shalom/client";
import { normalizeManualShalomGuide } from "@/lib/shalom/manual";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";
import { resolveOseIds } from "@/lib/shalom/ose-backfill";
import {
  ACTIVE_GUIDE_STATUSES,
  registerExistingShalomGuide,
  type ExistingGuideOrder,
} from "@/lib/shalom/register-guide";
import { readWithFreshSession, SHALOM_STORE_COLUMNS, type StoreShalom } from "@/lib/shalom/session";

const DAY_MS = 86_400_000;
/** Hasta dónde se buscan pedidos parados. El más viejo del 10-10-2026 tenía 81 días. */
const LOOKBACK_DAYS = 90;
/** Guías que se vinculan por pasada. Lo que sobre entra en la siguiente. */
export const MAX_LINKS_PER_RUN = 10;
/** El listado pagina; ~3 KB por orden. */
const PER_PAGE = 500;
/** 90 días de las dos tiendas son ~2.500 guías: 12 páginas sobran. */
const MAX_PAGES = 12;
/** `.in()` viaja en la URL: listas cortas. */
const CHUNK = 150;
/** Las guías de la API de la última hora pueden no estar todavía en el listado. */
const COVERAGE_LAG_MS = 2 * 3_600_000;
/** Muestra de guías de la API para comprobar el destinatario del listado. */
const CONTRACT_SAMPLE = 300;
/** Detalle del informe: lo justo para ir a mirar. */
const DETAIL_MAX = 40;

export interface CotejoDetail {
  pedido: string;
  resultado: "vinculado" | "ambiguo" | "sin_pareja" | "por_tope" | "error";
  guia?: string;
  via?: ShalomCotejoVia;
  motivo?: string;
}

export interface CotejoAccountReport {
  tiendas: string[];
  candidatos: number;
  desde: string;
  listado: number;
  paginas: number;
  cobertura: ListingCoverage | null;
  contrato: ListingContract | null;
  /** El `id` del listado se comprobó como OSE ID: la guía entra con su ticket. */
  oseVerificado: boolean;
  /** Por qué esta cuenta no se coteja (listado incompleto, error de Shalom…). */
  motivo: string | null;
}

export interface ShalomCotejoReport {
  candidatos: number;
  vinculados: number;
  ambiguos: number;
  sinPareja: number;
  /** Parejas seguras que esperan a la pasada siguiente por el tope. */
  porTope: number;
  /** Candidatos de una cuenta cuyo listado no se pudo leer entero o creer. */
  sinCotejar: number;
  cuentas: CotejoAccountReport[];
  detalle: CotejoDetail[];
  errores: string[];
}

interface CandidateRow extends ExistingGuideOrder {
  order_created_at: string | null;
  payment_state: string | null;
}

const ORDER_COLUMNS =
  "order_id,store_id,order_name,order_created_at,customer_name,customer_phone,district,province,region,payment_state";

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function phoneVariants(keys: Iterable<string>): string[] {
  return [...new Set([...keys].flatMap((k) => [`51${k}`, k, `+51${k}`]))];
}

/**
 * Los pedidos que esperan guía: pagados para Agencia (la misma regla que deja
 * pasar a Preparación, `agencyPaymentReady`), en «Preparación · Por generar
 * rótulo» y sin ninguna salida que estorbe — la misma que frena al drawer.
 * Una salida de Shalom viva o cerrada también los saca: ese pedido ya tiene
 * su guía en Kapta y no es lo que se busca.
 */
async function loadCandidates(admin: SupabaseClient, errores: string[]): Promise<CandidateRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString();
  const { data, error } = await admin
    .from("order_master")
    .select(ORDER_COLUMNS)
    .eq("macro_stage", "preparacion")
    .eq("macro_substage", "por_generar_rotulo")
    .gte("order_created_at", since)
    .limit(1000);
  if (error) {
    errores.push(`candidatos: ${error.message}`);
    return [];
  }
  const rows = ((data ?? []) as CandidateRow[]).filter((r) => agencyPaymentReady("agencia", r.payment_state));
  if (!rows.length) return [];

  const blocked = new Set<string>();
  for (const part of chunks(rows.map((r) => r.order_id))) {
    const { data: ships, error: shipErr } = await admin
      .from("shipments")
      .select("order_id,courier,delivery_status,created_via,custody_state,custody_transferred_at")
      .in("order_id", part);
    if (shipErr) {
      // Sin saber qué salidas tienen, ninguno de este tramo es candidato.
      errores.push(`salidas de los candidatos: ${shipErr.message}`);
      for (const id of part) blocked.add(id);
      continue;
    }
    for (const s of (ships ?? []) as {
      order_id: string;
      courier: string;
      delivery_status: string;
      created_via: string | null;
      custody_state: string | null;
      custody_transferred_at: string | null;
    }[]) {
      const shalom = s.courier.trim().toLowerCase() === "shalom" && s.delivery_status !== "anulado";
      const active = ACTIVE_GUIDE_STATUSES.has(s.delivery_status) && !isFillableRouteOutput(s);
      if (shalom || active) blocked.add(s.order_id);
    }
  }
  return rows.filter((r) => !blocked.has(r.order_id));
}

/**
 * El documento apuntado para el envío de cada pedido. Un fallo de lectura
 * SUBE: un DNI que no se leyó haría pasar por libre a quien podía discutir
 * la pareja.
 */
async function loadDocuments(admin: SupabaseClient, orderIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(orderIds)])) {
    const { data, error } = await admin.from("shalom_order_drafts").select("order_id,document").in("order_id", part);
    if (error) throw new Error(`documentos apuntados: ${error.message}`);
    for (const d of (data ?? []) as { order_id: string; document: string | null }[]) {
      const key = documentKey(d.document);
      if (key) out.set(d.order_id, key);
    }
  }
  return out;
}

interface KnownRow {
  guide_code: string;
  shalom_ose_id: number | null;
  order_id: string | null;
  created_at: string;
}

/** Las guías que Kapta creó por API para esta cuenta desde `fromIso`. */
async function loadKnownApiGuides(admin: SupabaseClient, storeIds: string[], fromIso: string): Promise<KnownRow[]> {
  const out: KnownRow[] = [];
  for (let page = 0; page < 10; page += 1) {
    const { data, error } = await admin
      .from("shipments")
      .select("guide_code,shalom_ose_id,order_id,created_at")
      .in("store_id", storeIds)
      .eq("courier", "shalom")
      .eq("created_via", SHALOM_ORIGIN.api)
      .neq("delivery_status", "anulado")
      .not("guide_code", "is", null)
      .gte("created_at", fromIso)
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`guías de la API: ${error.message}`);
    const rows = (data ?? []) as KnownRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** El celular de cada pedido, en sus 9 dígitos. */
async function loadPhones(admin: SupabaseClient, orderIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(orderIds)])) {
    const { data, error } = await admin.from("order_master").select("order_id,customer_phone").in("order_id", part);
    if (error) throw new Error(`celulares: ${error.message}`);
    for (const o of (data ?? []) as { order_id: string; customer_phone: string | null }[]) {
      const key = phoneKey(o.customer_phone);
      if (key) out.set(o.order_id, key);
    }
  }
  return out;
}

/**
 * Todos los pedidos de las tiendas de la cuenta que podrían ser los dueños de
 * una guía en juego: los que tienen su celular o su DNI. Estén como estén.
 */
async function loadRivals(
  admin: SupabaseClient,
  storeIds: string[],
  phones: Set<string>,
  docs: Set<string>,
  sinceIso: string,
): Promise<CandidateRow[]> {
  const byId = new Map<string, CandidateRow>();
  for (const part of chunks(phoneVariants(phones))) {
    const { data, error } = await admin
      .from("order_master")
      .select(ORDER_COLUMNS)
      .in("store_id", storeIds)
      .in("customer_phone", part)
      .gte("order_created_at", sinceIso)
      .limit(1000);
    if (error) throw new Error(`pedidos por celular: ${error.message}`);
    for (const o of (data ?? []) as CandidateRow[]) byId.set(o.order_id, o);
  }
  const byDoc: string[] = [];
  for (const part of chunks([...docs])) {
    const { data, error } = await admin
      .from("shalom_order_drafts")
      .select("order_id")
      .in("store_id", storeIds)
      .in("document", part)
      .limit(1000);
    if (error) throw new Error(`pedidos por DNI: ${error.message}`);
    for (const d of (data ?? []) as { order_id: string }[]) if (!byId.has(d.order_id)) byDoc.push(d.order_id);
  }
  for (const part of chunks([...new Set(byDoc)])) {
    const { data, error } = await admin.from("order_master").select(ORDER_COLUMNS).in("order_id", part);
    if (error) throw new Error(`pedidos por DNI: ${error.message}`);
    // Sin filtro de fecha: un pedido sin fecha cuenta como posible dueño, y
    // uno viejo lo descarta la ventana del cotejo.
    for (const o of (data ?? []) as CandidateRow[]) byId.set(o.order_id, o);
  }
  return [...byId.values()];
}

/** Guías que ya están en una salida de Shalom de Kapta. */
async function loadLinked(admin: SupabaseClient, guias: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(guias)])) {
    const { data, error } = await admin
      .from("shipments")
      .select("guide_code")
      .eq("courier", "shalom")
      .in("guide_code", part);
    if (error) throw new Error(`guías vinculadas: ${error.message}`);
    for (const s of (data ?? []) as { guide_code: string | null }[]) if (s.guide_code) out.add(guideCodeKey(s.guide_code));
  }
  return out;
}

interface AccountGroup {
  store: StoreShalom;
  storeId: string;
  storeIds: string[];
  candidates: CandidateRow[];
}

async function groupByAccount(
  admin: SupabaseClient,
  candidates: CandidateRow[],
  errores: string[],
): Promise<{ groups: AccountGroup[]; sinCuenta: CandidateRow[] }> {
  const storeIds = [...new Set(candidates.map((c) => c.store_id))];
  const { data, error } = await admin.from("stores").select(`id,${SHALOM_STORE_COLUMNS}`).in("id", storeIds);
  if (error) {
    errores.push(`tiendas: ${error.message}`);
    return { groups: [], sinCuenta: candidates };
  }
  const stores = new Map(((data ?? []) as (StoreShalom & { id: string })[]).map((s) => [s.id, s]));
  const groups = new Map<string, AccountGroup>();
  const sinCuenta: CandidateRow[] = [];
  for (const c of candidates) {
    const s = stores.get(c.store_id);
    const email = (s?.shalom_pro_email ?? "").trim().toLowerCase();
    if (!s || !email || !s.shalom_pro_password_enc) {
      sinCuenta.push(c);
      continue;
    }
    // La cuenta de Shalom Pro, no la tienda: Kenku y Aurela comparten una y
    // sus guías salen en el MISMO listado.
    const key = `${s.org_id}|${email}`;
    const g = groups.get(key) ?? { store: s, storeId: s.id, storeIds: [], candidates: [] };
    g.candidates.push(c);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const { data: siblings } = await admin
      .from("stores")
      .select("id,shalom_pro_email")
      .eq("org_id", g.store.org_id);
    const email = (g.store.shalom_pro_email ?? "").trim().toLowerCase();
    g.storeIds = ((siblings ?? []) as { id: string; shalom_pro_email: string | null }[])
      .filter((s) => (s.shalom_pro_email ?? "").trim().toLowerCase() === email)
      .map((s) => s.id);
    if (!g.storeIds.length) g.storeIds = [g.storeId];
  }
  return { groups: [...groups.values()], sinCuenta };
}

function toCotejoOrder(
  o: CandidateRow,
  docs: Map<string, string>,
  candidate: boolean,
): CotejoShalomOrder {
  return {
    orderId: o.order_id,
    storeId: o.store_id,
    orderName: o.order_name,
    createdAt: o.order_created_at,
    customerName: o.customer_name,
    phone: phoneKey(o.customer_phone),
    document: docs.get(o.order_id) ?? null,
    candidate,
  };
}

function pushDetail(report: ShalomCotejoReport, d: CotejoDetail): void {
  if (report.detalle.length < DETAIL_MAX) report.detalle.push(d);
}

/**
 * Una pasada de Cotejar Shalom. Barata cuando no hay nada que buscar: una
 * consulta y vuelve, sin llamar a Shalom.
 *
 * @param deadlineMs  hora límite (epoch ms) para terminar de bajar el listado.
 *                    Un listado a medias no vincula nada.
 */
export async function cotejarShalom(
  admin: SupabaseClient,
  opts: { deadlineMs: number; maxLinks?: number },
): Promise<ShalomCotejoReport> {
  const report: ShalomCotejoReport = {
    candidatos: 0,
    vinculados: 0,
    ambiguos: 0,
    sinPareja: 0,
    porTope: 0,
    sinCotejar: 0,
    cuentas: [],
    detalle: [],
    errores: [],
  };
  const candidates = await loadCandidates(admin, report.errores);
  report.candidatos = candidates.length;
  if (!candidates.length) return report;

  const { groups, sinCuenta } = await groupByAccount(admin, candidates, report.errores);
  report.sinCotejar += sinCuenta.length;
  let linksLeft = opts.maxLinks ?? MAX_LINKS_PER_RUN;

  for (const group of groups) {
    const oldest = Math.min(
      ...group.candidates.map((c) => Date.parse(c.order_created_at ?? "")).filter(Number.isFinite),
    );
    const desde = new Date((Number.isFinite(oldest) ? oldest : Date.now()) - 2 * DAY_MS).toISOString().slice(0, 10);
    const account: CotejoAccountReport = {
      tiendas: group.storeIds,
      candidatos: group.candidates.length,
      desde,
      listado: 0,
      paginas: 0,
      cobertura: null,
      contrato: null,
      oseVerificado: false,
      motivo: null,
    };
    report.cuentas.push(account);
    const skip = (motivo: string) => {
      account.motivo = motivo;
      report.sinCotejar += group.candidates.length;
      report.errores.push(`Cotejar Shalom (${desde}): ${motivo}`);
    };

    // Sin un minuto por delante no se empieza: la sesión puede pedir el login
    // de ~90 s y la función tiene 300.
    if (opts.deadlineMs - Date.now() < 60_000) {
      skip("no quedó tiempo en esta pasada");
      continue;
    }

    try {
      // 1. El listado ENTERO desde el pedido más viejo.
      const collected = await readWithFreshSession(admin, group.storeId, group.store, (client) =>
        collectListingPages(
          (page, left) => client.ordersSince(desde, PER_PAGE, { page, timeoutMs: Math.min(SLOW_TIMEOUT_MS, left) }),
          { perPage: PER_PAGE, maxPages: MAX_PAGES, deadlineMs: opts.deadlineMs },
        ),
      );
      account.listado = collected.orders.length;
      account.paginas = collected.paginas;
      if (!collected.completo) {
        skip(`el listado de Shalom no se leyó entero: ${collected.motivo}`);
        continue;
      }
      const guides = collected.orders.map(readListingGuide).filter((g): g is ShalomListingGuide => Boolean(g));

      // 2. ¿Está entero de verdad? Las guías de la API del periodo tienen que estar.
      const fromIso = `${desde}T00:00:00Z`;
      const known = await loadKnownApiGuides(admin, group.storeIds, fromIso);
      const lagLimit = Date.now() - COVERAGE_LAG_MS;
      const expected = known
        .filter((k) => {
          const t = Date.parse(k.created_at);
          return t >= Date.parse(fromIso) + DAY_MS && t <= lagLimit;
        })
        .map((k) => k.guide_code);
      account.cobertura = listingCoverage(guides, expected);
      if (!account.cobertura.completo) {
        skip(
          `al listado le faltan guías creadas por API (${account.cobertura.encontradas} de ${account.cobertura.esperadas}): no se vincula nada`,
        );
        continue;
      }

      // 3. ¿Su destinatario es el destinatario? Se compara con lo que Kapta sabe.
      const inListing = new Set(guides.map((g) => g.guia));
      const sample = known.filter((k) => k.order_id && inListing.has(guideCodeKey(k.guide_code))).slice(-CONTRACT_SAMPLE);
      const sampleIds = sample.map((k) => k.order_id as string);
      const [sampleDocs, samplePhones] = await Promise.all([loadDocuments(admin, sampleIds), loadPhones(admin, sampleIds)]);
      const knownReceivers: KnownApiGuide[] = sample.map((k) => ({
        guideCode: k.guide_code,
        document: sampleDocs.get(k.order_id as string) ?? null,
        phone: samplePhones.get(k.order_id as string) ?? null,
      }));
      account.contrato = checkListingContract(guides, knownReceivers);
      const usable = { documento: account.contrato.documento.confiable, telefono: account.contrato.telefono.confiable };
      if (!usable.documento && !usable.telefono) {
        skip("el destinatario del listado no coincide con el de las guías creadas por API: no se vincula nada");
        continue;
      }

      // 4. Las guías en juego y todos los pedidos que podrían discutirlas.
      const candDocs = await loadDocuments(admin, group.candidates.map((c) => c.order_id));
      const candidateOrders = group.candidates.map((c) => toCotejoOrder(c, candDocs, true));
      const docs = new Set(candidateOrders.map((o) => o.document).filter((d): d is string => Boolean(d)));
      const phones = new Set(candidateOrders.map((o) => o.phone).filter((p): p is string => Boolean(p)));
      const relevant = guides.filter((g) => (g.document && docs.has(g.document)) || (g.phone && phones.has(g.phone)));
      for (const g of relevant) {
        if (g.document) docs.add(g.document);
        if (g.phone) phones.add(g.phone);
      }
      const linked = await loadLinked(admin, relevant.map((g) => g.guia));
      const sinceRivals = new Date(Date.parse(fromIso) - (WINDOW_AFTER_DAYS + 1) * DAY_MS).toISOString();
      const rivalRows = await loadRivals(admin, group.storeIds, phones, docs, sinceRivals);
      const candidateIds = new Set(group.candidates.map((c) => c.order_id));
      const others = rivalRows.filter((r) => !candidateIds.has(r.order_id));
      const otherDocs = await loadDocuments(admin, others.map((o) => o.order_id));
      const universe = [...candidateOrders, ...others.map((o) => toCotejoOrder(o, otherDocs, false))];

      const outcomes = matchShalomListing(relevant, universe, linked, usable);

      // 5. El OSE ID, si el listado demuestra que su `id` lo es (ose-backfill.ts).
      const ose = resolveOseIds(
        collected.orders,
        known.filter((k) => k.shalom_ose_id).map((k) => ({ guideCode: k.guide_code, oseId: Number(k.shalom_ose_id) })),
        outcomes.flatMap((o) => (o.kind === "vincular" ? [o.guide.guia] : [])),
      );
      account.oseVerificado = ose.trusted;

      // 6. Registrar, por el camino del drawer.
      const rows = new Map(group.candidates.map((c) => [c.order_id, c]));
      for (const outcome of outcomes) {
        const pedido = outcome.order.orderName ?? outcome.order.orderId;
        if (outcome.kind === "sin_pareja") {
          report.sinPareja += 1;
          pushDetail(report, { pedido, resultado: "sin_pareja" });
          continue;
        }
        if (outcome.kind === "ambiguo") {
          report.ambiguos += 1;
          pushDetail(report, { pedido, resultado: "ambiguo", motivo: outcome.reason });
          continue;
        }
        const { guide, via } = outcome;
        if (linksLeft <= 0) {
          report.porTope += 1;
          pushDetail(report, { pedido, resultado: "por_tope", guia: guide.guia, via });
          continue;
        }
        const normalized = normalizeManualShalomGuide({
          guideCode: guide.guia,
          codigo: guide.codigo,
          serie: guide.serie,
          oseId: ose.trusted ? (ose.resolved.get(guide.guia) ?? null) : null,
        });
        const row = rows.get(outcome.order.orderId);
        if (!normalized.ok || !row) {
          const motivo = normalized.ok ? "pedido no encontrado" : normalized.error;
          report.errores.push(`${pedido}: ${motivo}`);
          pushDetail(report, { pedido, resultado: "error", guia: guide.guia, motivo });
          continue;
        }
        linksLeft -= 1;
        const res = await registerExistingShalomGuide(admin, row, normalized.value, {
          actor: null,
          onlyIfNew: true,
          cotejo: {
            motivo: via === "dni" ? "mismo DNI" : "mismo celular y nombre",
            payload: {
              via,
              listado_id: guide.listingId,
              guia_creada_en_shalom: guide.createdAt,
            },
          },
        });
        if (!res.ok) {
          report.errores.push(`${pedido}: ${res.error}`);
          pushDetail(report, { pedido, resultado: "error", guia: guide.guia, via, motivo: res.error });
          continue;
        }
        report.vinculados += 1;
        pushDetail(report, { pedido, resultado: "vinculado", guia: guide.guia, via });
      }
    } catch (e) {
      skip(describeShalomError(e));
    }
  }
  return report;
}
