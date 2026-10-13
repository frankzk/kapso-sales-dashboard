// «Repro Lima»: quién entra y qué ve (fase 1, entrega 1a; MOM §9.5).
//
// Entra quien despacha (`dispatch.manage`, el permiso de «Programar»), en las
// tiendas que tiene en Equipo: el mismo alcance que Despacho del día
// (`getAccessibleStores`, E36). La lista sale del Master —todo «En curso · Por
// reprogramar Lima» de esas tiendas, de cualquier courier— y se cruza con los
// casos (`lima_repro_cases`), el programa de Grupo GF y los hechos de cada
// pedido (lib/repro-lima-program.ts). Las cuatro listas son etiquetas de esta
// pantalla, no subetapas (D2).
//
// Los casos que ya no sirven (el pedido salió de la etapa, o tuvo un fallo
// posterior) se cierran después de responder (`after()`), sin evento: la fila
// ya los trata como ausentes.

import { after } from "next/server";
import { redirect } from "next/navigation";
import type { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { resolveAgentNames } from "@/lib/agent-names";
import { allCourierRows, courierRowsByIds } from "@/lib/courier-flow";
import { limaClock, sameDayCutoffLabel } from "@/lib/grupo-gf-courier";
import { limaDay } from "@/lib/dispatch-day";
import { guideFailedAt } from "@/lib/reproprovincia";
import type { OwnReplaceDecision } from "@/lib/gf-retry";
import { priorOutputsWith } from "@/lib/repro-box-action";
import {
  agreementState,
  agreementStateLabel,
  boxLocationLabel,
  claimView,
  cutoffNotice,
  dismantleSuggested,
  failureLine,
  isAgreementBoxAction,
  isReproCourier,
  materializationPlan,
  normalizeReproChanges,
  porDecidirRank,
  programOrigin,
  reproCourierName,
  reproList,
  sortRepro,
  REPRO_COURIERS,
  type AgreementState,
  type BoxLocation,
  type ClaimView,
  type MaterializationPlan,
  type ProgramOrigin,
  type ReproChanges,
  type ReproChip,
  type ReproCourier,
  type ReproList,
} from "@/lib/repro-lima";
import {
  closeStaleReproCases,
  loadReproFacts,
  reproCaseProblem,
  REPRO_ORDER_COLUMNS,
  type ReproCaseRow,
  type ReproFacts,
  type ReproOrderRow,
  type ReproProviderRow,
} from "@/lib/repro-lima-program";

export { loadReproFacts, type ReproFacts } from "@/lib/repro-lima-program";

type Admin = ReturnType<typeof createAdminSupabase>;

/** Sin `dispatch.manage` (E32). */
export const REPRO_NO_PERMISSION = "Repro Lima es de quien despacha (rol admin o vendedora). Pide acceso en Equipo.";
export const REPRO_NO_STORES = "No tienes tiendas asignadas. Pide acceso en Equipo.";
export const REPRO_OUTSIDE_STORE = "No tienes acceso a la tienda de este pedido.";

/** Quién mira y en qué tiendas. */
export interface ReproScope {
  userId: string;
  storeIds: ReadonlySet<string>;
}

/**
 * La puerta de la pantalla y de cada acción. Sin sesión, a /login. Sin el
 * permiso o sin tiendas, el motivo (`reason` dice cuál, para la pantalla).
 */
export async function requireReproLima(): Promise<ReproScope | { error: string; reason: "permiso" | "tiendas" }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const permissions = await getMasterPermissions();
  if (!permissions.can("dispatch.manage")) return { error: REPRO_NO_PERMISSION, reason: "permiso" };
  const stores = await getAccessibleStores();
  if (!stores.length) return { error: REPRO_NO_STORES, reason: "tiendas" };
  return { userId: user.id, storeIds: new Set(stores.map((store) => store.id)) };
}

/** Una fila de la pantalla: todo lo de D13 y lo que hace falta para decidir. */
export interface ReproRow {
  orderId: string;
  storeId: string;
  storeName: string;
  orderName: string;
  customerName: string;
  customerPhone: string | null;
  district: string | null;
  orderTotal: number;
  /** Desde cuándo está en la etapa (`order_master.macro_since`). */
  macroSince: string | null;
  /** «6 d en la etapa». */
  daysInStage: number | null;
  /** «Salidas 2 de 5 · KP…-S02 Grupo GF». */
  outputsUsed: number;
  lastOutput: { code: string | null; courier: string; courierName: string } | null;
  /** El fallo en una línea (§11.7), con la foto de la parada si hay (`/api/reparto/foto?path=`). */
  failure: { text: string; rejected: boolean; photoPath: string | null } | null;
  /** La fecha que pidió el cliente en la parada (D9). Nunca se preselecciona. */
  requestedDate: string | null;
  box: BoxLocation;
  boxLabel: string;
  /** Cuándo se recibió en oficina la caja del episodio (`ReproFacts.receivedAt`). */
  receivedAt: string | null;
  /** Reintento de otro courier: Grupo GF crea la salida al tomarlo. */
  retryAdmission: boolean;
  episodeKey: string;
  episodeAt: string | null;
  /** El caso abierto del episodio vigente; null si no hay (nace al «Atender»). */
  caseId: string | null;
  claim: { view: ClaimView; by: string | null; byName: string | null; until: string | null };
  callCount: number;
  noAnswerCount: number;
  /** La última llamada del caso: «última 11/10 16:20, Daysi». */
  lastCall: { at: string; byName: string | null; outcome: string | null } | null;
  nextCallAt: string | null;
  /** El acuerdo vigente del caso. */
  agreement: {
    callId: string;
    agreedOn: string;
    courier: string;
    courierName: string;
    changes: ReproChanges;
    boxAction: string | null;
    boxLocation: string | null;
    decidedBy: string | null;
    decidedByName: string | null;
    decidedAt: string | null;
    materializedAt: string | null;
    materializedOn: string | null;
  } | null;
  state: AgreementState;
  stateLabel: string;
  /** Cuándo se programa el acuerdo con los hechos de ahora; null sin acuerdo. */
  plan: MaterializationPlan | null;
  program: { scheduledFor: string; reason: string | null; origin: ProgramOrigin } | null;
  list: ReproList;
  /** `porDecidirRank` (solo cuenta en «Por decidir»). */
  rank: number;
  overdue: boolean;
  chips: ReproChip[];
  /** «Sugerido: desarmar y cerrar» (decisión 10). Solo una chapa. */
  dismantleSuggested: boolean;
  /** El «Desarmar y cerrar» del episodio vigente («Cerrados», «Volver a atender»). */
  closed: { caseId: string; at: string | null; byName: string | null; note: string | null } | null;
  /** El caso abierto reabre un «Desarmar y cerrar» (E29). */
  reopened: boolean;
  /** Lo que `reproBoxAction` necesita además de lo que elige quien decide. */
  boxInputs: {
    ownLiveCourier: string | null;
    lastFailedCourier: string | null;
    otherLiveCourier: string | null;
    hadPropio: boolean;
    totalOutputs: number;
    priorByCourier: Record<ReproCourier, number>;
    ownReplace: { decision: OwnReplaceDecision; outputCode: string | null } | null;
  };
  /** El corte del mismo día del proveedor de su organización. */
  cutoff: string | null;
  // Para ordenar (`sortRepro`).
  agreedOn: string | null;
  programDay: string | null;
  closedAt: string | null;
}

export interface ReproLimaData {
  today: string;
  nowIso: string;
  /** «12:00»: el corte del proveedor (nunca fijo, D6). */
  cutoffLabel: string;
  cutoffPassed: boolean;
  /** «Lo que confirmes hasta las 12:00 sale hoy» o «Pasó el corte: lo confirmado sale mañana». */
  cutoffText: string;
  stores: { id: string; name: string }[];
  rows: ReproRow[];
  me: string;
}

const DAY_MS = 86_400_000;

function daysBetweenDays(from: string | null, to: string): number | null {
  if (!from) return null;
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/**
 * El fallo que se enseña: la parada o la salida de otro courier, la más
 * reciente. Se comparan días (el de la ruta de la parada, el del fallo de la
 * guía) antes que horas: el `reported_at` de la parada se reescribe en cada
 * corrección del reporte.
 *
 * `failedOn` ordena «Por decidir» (rango 0). De Tanders y Swayp es el día en
 * que salió el intento (`guideFailedAt`, el mismo ancla que `macro_since`): no
 * hay un sello fijo del fallo. La línea lo dice como salida, no como fallo.
 */
function failureOf(f: ReproFacts): { line: ReproRow["failure"]; failedOn: string | null } {
  const stop = f.lastStop;
  const output = f.failedOutput;
  const outputAt = output ? guideFailedAt(output) : null;
  const stopDay = stop ? stop.routeDate?.slice(0, 10) ?? limaDay(stop.reported_at) ?? "" : "";
  const outputDay = limaDay(outputAt) ?? "";
  const stopFirst = stopDay !== outputDay ? stopDay > outputDay : (stop?.reported_at ?? "") >= (outputAt ?? "");
  if (stop && (!output || stopFirst)) {
    const line = failureLine({
      kind: "parada",
      riderName: stop.riderName,
      routeDate: stop.routeDate,
      outcomeReason: stop.outcome_reason,
      note: stop.note,
    });
    return { line: { ...line, photoPath: stop.photo_path }, failedOn: stop.routeDate ?? limaDay(stop.reported_at) };
  }
  if (output) {
    const fromDispatch = Boolean(outputAt) && outputAt === output.dispatched_at;
    const line = failureLine({
      kind: "courier",
      courier: output.courier,
      reportedStatus: output.reported_status,
      swaypState: output.swayp_state,
      failedOn: fromDispatch ? null : outputAt,
      dispatchedOn: fromDispatch ? outputAt : null,
    });
    return { line: { ...line, photoPath: null }, failedOn: limaDay(outputAt) };
  }
  return { line: null, failedOn: null };
}

/** Arma la fila de un pedido con sus hechos. Pura salvo los nombres, que ya vienen. */
function buildRow(input: {
  f: ReproFacts;
  order: ReproOrderRow;
  storeName: string;
  me: string;
  now: Date;
  today: string;
  names: Record<string, string>;
  lastCall: { at: string; actor: string | null; outcome: string | null } | null;
}): ReproRow {
  const { f, order, now, today, names } = input;
  // Un caso de otro episodio cuenta como ausente: se cierra después de responder.
  const open = f.open && f.open.episode_key === f.episode.key ? f.open : null;
  const courier = open?.agreed_courier && isReproCourier(open.agreed_courier) ? open.agreed_courier : null;
  const boxAction = open?.box_action && isAgreementBoxAction(open.box_action) ? open.box_action : null;
  const plan = open?.agreed_on && courier && boxAction
    ? materializationPlan({ courier, boxAction, box: f.box, retryAdmission: f.retryAdmission })
    : null;
  const program = f.program
    ? { scheduled_for: f.program.scheduled_for.slice(0, 10), reason: f.program.reason ?? null, set_at: f.program.set_at ?? null }
    : null;
  const cutoff = f.provider?.same_day_cutoff ?? null;
  // Con el minuto y el corte: un acuerdo para hoy que ya no alcanza vence hoy (E25).
  const state = agreementState({
    c: open,
    program,
    box: f.box,
    plan,
    today,
    programRemovedAt: f.programRemovedAt,
    nowMinute: limaClock(now).minute,
    cutoff,
  });
  const requestedDate = f.lastStop?.requested_date?.slice(0, 10) ?? null;
  const listed = reproList({
    open,
    latestClosed: f.latestClosed,
    episodeKey: f.episode.key,
    state,
    program,
    now,
    today,
    requestedDate,
  });
  const failure = failureOf(f);
  const rank = porDecidirRank({ macroSince: order.macro_since, today, overdue: listed.overdue, failedOn: failure.failedOn });
  const latestOutput = [...f.outputs].sort((a, b) => (b.output_number ?? 0) - (a.output_number ?? 0))[0] ?? null;
  const closedCase: ReproCaseRow | null = !open && f.latestClosed?.close_reason === "desarmar_cerrar" && f.latestClosed.episode_key === f.episode.key
    ? f.latestClosed
    : null;
  const priorByCourier = Object.fromEntries(
    REPRO_COURIERS.map((c) => [c, priorOutputsWith(f.outputs, c)]),
  ) as Record<ReproCourier, number>;
  return {
    orderId: f.orderId,
    storeId: order.store_id,
    storeName: input.storeName,
    orderName: order.order_name ?? "Pedido sin código",
    customerName: order.customer_name ?? "Cliente sin nombre",
    customerPhone: order.customer_phone,
    district: order.district,
    orderTotal: Number(order.order_total ?? 0),
    macroSince: order.macro_since,
    daysInStage: daysBetweenDays(limaDay(order.macro_since), today),
    outputsUsed: f.outputs.length,
    lastOutput: latestOutput
      ? { code: latestOutput.output_code ?? latestOutput.guide_code ?? null, courier: latestOutput.courier, courierName: reproCourierName(latestOutput.courier) }
      : null,
    failure: failure.line,
    requestedDate,
    box: f.box,
    boxLabel: boxLocationLabel(f.box),
    receivedAt: f.receivedAt,
    retryAdmission: f.retryAdmission,
    episodeKey: f.episode.key,
    episodeAt: f.episode.at,
    caseId: open?.id ?? null,
    claim: {
      view: claimView(open?.claimed_by, open?.claimed_until, input.me, now),
      by: open?.claimed_by ?? null,
      byName: open?.claimed_by ? names[open.claimed_by] ?? null : null,
      until: open?.claimed_until ?? null,
    },
    callCount: open?.call_count ?? 0,
    noAnswerCount: open?.no_answer_count ?? 0,
    lastCall: input.lastCall
      ? { at: input.lastCall.at, byName: input.lastCall.actor ? names[input.lastCall.actor] ?? null : null, outcome: input.lastCall.outcome }
      : null,
    nextCallAt: open?.next_call_at ?? null,
    agreement: open?.agreed_on && open.agreement_call_id
      ? {
          callId: open.agreement_call_id,
          agreedOn: open.agreed_on.slice(0, 10),
          courier: open.agreed_courier ?? "",
          courierName: reproCourierName(open.agreed_courier),
          changes: normalizeReproChanges(open.changes),
          boxAction: open.box_action,
          boxLocation: open.box_location,
          decidedBy: open.decided_by,
          decidedByName: open.decided_by ? names[open.decided_by] ?? null : null,
          decidedAt: open.decided_at,
          materializedAt: open.materialized_at,
          materializedOn: open.materialized_on,
        }
      : null,
    state,
    stateLabel: agreementStateLabel(state, open ? { agreed_on: open.agreed_on, agreed_courier: open.agreed_courier } : null, f.box, today),
    plan,
    program: program ? { scheduledFor: program.scheduled_for, reason: program.reason, origin: programOrigin(program.reason) } : null,
    list: listed.list,
    rank,
    overdue: listed.overdue,
    chips: listed.chips,
    // Los diez días cuentan desde la recepción de la caja que está en oficina
    // (decisión 10): con la caja con el motorizado o volviendo, no se sugiere.
    dismantleSuggested: dismantleSuggested({
      receivedAt: f.box.kind === "en_oficina" ? f.box.since : null,
      noAnswerCount: open?.no_answer_count ?? 0,
      today,
    }),
    closed: closedCase
      ? {
          caseId: closedCase.id,
          at: closedCase.closed_at,
          byName: closedCase.closed_by ? names[closedCase.closed_by] ?? null : null,
          note: closedCase.close_note,
        }
      : null,
    reopened: Boolean(open && f.reopened),
    boxInputs: {
      ownLiveCourier: f.ownLive?.courier ?? null,
      lastFailedCourier: f.failedOutput?.courier ?? null,
      otherLiveCourier: f.otherLiveCourier,
      hadPropio: f.hadPropio,
      totalOutputs: f.outputs.length,
      priorByCourier,
      ownReplace: f.ownReplace,
    },
    cutoff,
    agreedOn: open?.agreed_on?.slice(0, 10) ?? null,
    programDay: program?.scheduled_for ?? null,
    closedAt: closedCase?.closed_at ?? null,
  };
}

/**
 * La pantalla entera: los pedidos de la etapa en las tiendas a su alcance,
 * con sus hechos, en tres oleadas de lecturas por lotes. `orderIds` acota a
 * esos pedidos (la hoja relee el suyo al abrirse). Los casos que ya no sirven
 * se cierran en `after()`.
 */
export async function loadReproLima(
  admin: Admin,
  scope: ReproScope,
  now: Date = new Date(),
  opts: { orderIds?: readonly string[]; defer?: (task: () => Promise<void>) => void } = {},
): Promise<ReproLimaData> {
  const clock = limaClock(now);
  const today = clock.day;
  const storeIds = [...scope.storeIds];
  const onlyOrders = opts.orderIds ? [...new Set(opts.orderIds.filter(Boolean))] : null;
  const empty = (cutoff: string | null, stores: { id: string; name: string }[]): ReproLimaData => {
    const notice = cutoffNotice(cutoff, now);
    return { today, nowIso: now.toISOString(), cutoffLabel: sameDayCutoffLabel(cutoff), cutoffPassed: notice.passed, cutoffText: notice.text, stores, rows: [], me: scope.userId };
  };
  if (!storeIds.length || (onlyOrders && !onlyOrders.length)) return empty(null, []);

  // Oleada 1: la etapa, los casos abiertos, las tiendas y el proveedor.
  const [orderRows, openCases, { data: storeRows }, { data: providerRows }] = await Promise.all([
    allCourierRows<ReproOrderRow>((from, to) => {
      let query = admin
        .from("order_master")
        .select(REPRO_ORDER_COLUMNS)
        .in("store_id", storeIds)
        .eq("macro_stage", "en_curso")
        .eq("macro_substage", "por_reprogramar_lima");
      if (onlyOrders) query = query.in("order_id", onlyOrders);
      return query.order("order_id").range(from, to) as unknown as PromiseLike<{ data: ReproOrderRow[] | null; error: { message: string } | null }>;
    }),
    courierRowsByIds(storeIds, (chunk) => {
      let query = admin.from("lima_repro_cases").select("id,order_id").in("store_id", chunk).is("closed_at", null);
      if (onlyOrders) query = query.in("order_id", onlyOrders);
      return query as unknown as PromiseLike<{ data: Array<{ id: string; order_id: string }> | null; error: { message: string } | null }>;
    }).then((result) => result.data),
    courierRowsByIds(storeIds, (chunk) => admin.from("stores").select("id,name,org_id").in("id", chunk)),
    admin.from("logistics_providers").select("id,org_id,status,same_day_cutoff").eq("code", "grupo-gf-courier"),
  ]);
  const stores = (storeRows as Array<{ id: string; name: string; org_id: string }>)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const storeName = new Map(stores.map((store) => [store.id, store.name]));
  const storeOrg = new Map(stores.map((store) => [store.id, store.org_id]));
  const orgs = new Set(stores.map((store) => store.org_id));
  const providers = new Map(((providerRows ?? []) as ReproProviderRow[])
    .filter((provider) => orgs.has(provider.org_id))
    .map((provider) => [provider.org_id, provider]));
  const headerCutoff = (stores[0] ? providers.get(stores[0].org_id)?.same_day_cutoff : null) ?? null;
  const visibleStores = stores.map((store) => ({ id: store.id, name: store.name }));

  const rows = orderRows.filter((row) => scope.storeIds.has(row.store_id));
  const inStage = new Set(rows.map((row) => row.order_id));
  // Candidatos, no cierres: la etapa se lee por páginas y un pedido que sale
  // de ella entre página y página corre a los demás. Se releen antes de cerrar.
  const outOfStage = openCases.filter((row) => !inStage.has(row.order_id));

  // Oleadas 2 y 3: los hechos de cada pedido.
  const facts = await loadReproFacts(admin, rows.map((row) => row.order_id), { orders: rows, storeOrg, providers });

  // Casos de otro episodio, más reciente: se cierran como nuevo intento.
  const newAttempt: string[] = [];
  const outOfStageInFacts: string[] = [];
  for (const f of facts.values()) {
    if (!f.open) continue;
    const problem = reproCaseProblem(f, f.open);
    if (problem?.reason === "nuevo_intento") newAttempt.push(f.open.id);
    else if (problem?.reason === "fuera_de_etapa") outOfStageInFacts.push(f.open.id);
  }

  // Nombres: quién tiene el candado, quién decidió, quién cerró y quién llamó.
  const openIds = [...facts.values()]
    .map((f) => (f.open && f.open.episode_key === f.episode.key ? f.open.id : null))
    .filter((id): id is string => Boolean(id));
  // Todas las llamadas de cada lote de casos, por páginas y en orden fijo: una
  // respuesta trae 1000 filas como mucho y cortaría la última llamada.
  const { data: callRows } = await courierRowsByIds(openIds, (chunk) => allCourierRows((from, to) => admin
    .from("lima_repro_calls")
    .select("case_id,actor,occurred_at,outcome,channel")
    .in("case_id", chunk)
    .neq("channel", "sin_contacto")
    .order("case_id")
    .order("occurred_at", { ascending: false })
    .order("id")
    .range(from, to) as unknown as PromiseLike<{ data: Array<{ case_id: string; actor: string | null; occurred_at: string; outcome: string | null; channel: string | null }> | null; error: { message: string } | null }>)
    .then((data) => ({ data, error: null })));
  const lastCallByCase = new Map<string, { at: string; actor: string | null; outcome: string | null }>();
  for (const call of callRows as Array<{ case_id: string; actor: string | null; occurred_at: string; outcome: string | null; channel: string | null }>) {
    // «Desarmar y cerrar sin llamada» no es una llamada.
    if (call.channel === "sin_contacto") continue;
    const current = lastCallByCase.get(call.case_id);
    if (!current || call.occurred_at > current.at) lastCallByCase.set(call.case_id, { at: call.occurred_at, actor: call.actor, outcome: call.outcome });
  }
  const people = new Set<string>();
  for (const f of facts.values()) {
    for (const c of [f.open, f.latestClosed]) {
      if (!c) continue;
      for (const id of [c.claimed_by, c.decided_by, c.closed_by]) if (id) people.add(id);
    }
  }
  for (const call of lastCallByCase.values()) if (call.actor) people.add(call.actor);
  let names: Record<string, string> = {};
  try {
    names = await resolveAgentNames(people, admin);
  } catch {
    names = {};
  }

  const built: ReproRow[] = [];
  for (const order of rows) {
    const f = facts.get(order.order_id);
    if (!f) continue;
    const openId = f.open && f.open.episode_key === f.episode.key ? f.open.id : null;
    built.push(buildRow({
      f,
      order,
      storeName: storeName.get(order.store_id) ?? "Tienda",
      me: scope.userId,
      now,
      today,
      names,
      lastCall: openId ? lastCallByCase.get(openId) ?? null : null,
    }));
  }

  // Cierres sin evento, después de responder (`after()`).
  const nowIso = now.toISOString();
  if (outOfStage.length || outOfStageInFacts.length || newAttempt.length) {
    const task = async () => {
      try {
        // Lo que no vino en la lectura por páginas se relee por id: solo se
        // cierra lo que de verdad ya no está en «Por reprogramar Lima».
        const { data: still } = await courierRowsByIds([...new Set(outOfStage.map((row) => row.order_id))], (chunk) => admin
          .from("order_master")
          .select("order_id")
          .in("order_id", chunk)
          .eq("macro_stage", "en_curso")
          .eq("macro_substage", "por_reprogramar_lima") as unknown as PromiseLike<{ data: Array<{ order_id: string }> | null; error: { message: string } | null }>);
        const stillInStage = new Set(still.map((row) => row.order_id));
        const closeOut = [...new Set([
          ...outOfStage.filter((row) => !stillInStage.has(row.order_id)).map((row) => row.id),
          ...outOfStageInFacts,
        ])];
        await closeStaleReproCases(admin, closeOut, "fuera_de_etapa", nowIso);
        await closeStaleReproCases(admin, newAttempt, "nuevo_intento", nowIso);
      } catch (error) {
        console.error("repro-lima: cierre de casos", error instanceof Error ? error.message : error);
      }
    };
    (opts.defer ?? after)(task);
  }

  const notice = cutoffNotice(headerCutoff, now);
  return {
    today,
    nowIso,
    cutoffLabel: sameDayCutoffLabel(headerCutoff),
    cutoffPassed: notice.passed,
    cutoffText: notice.text,
    stores: visibleStores,
    rows: sortRepro(built),
    me: scope.userId,
  };
}
