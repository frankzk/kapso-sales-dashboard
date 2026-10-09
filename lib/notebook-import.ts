// La hoja del motorizado sin app, cargada desde Kapta (MOM §29.7). Puro y
// probado (test/notebook-import.test.ts).
//
// Alexis no usa la app: manda una foto de su hoja por día. Esto toma las filas
// que leyó la visión (lib/rider-sheet-vision.ts), las cruza con su ruta y
// propone, fila por fila, qué cargar. Las reglas son las que se aplicaron a
// mano del 01 al 06/10 (docs/runbooks/cuaderno-a-rutas.md):
//
//   * Lo escrito manda el reporte: EFECTIVO y PAGO POS son entregas; SOLO
//     ENTREGA es entrega sin cobro (ya estaba pagado); RECHAZO y COBRO CAIDA,
//     «Rechazó el pedido»; CAIDA y ANULADO, «Otro» con la palabra en la nota
//     (ANULADO no anula: solo Shopify anula, §9); NO CONTESTO, «No contesta»;
//     REPRO, LUNES, MIÉRCOLES…, «Reprogramado». Lo que no se entiende no se
//     adivina: queda para que lo elija una persona.
//   * Solo se carga lo que está en la caja del motorizado (§29.5). La única
//     puerta extra es el reprogramado que él conservó de un día anterior: pasa
//     a esta ruta, ya cotejado, y se reporta aquí (§29.7, 07-10-2026).
//   * Lo demás —anulado en Shopify, en la caja de otro, sin código, que no
//     existe— se enseña con su motivo y no se carga.
//   * Una fila sin código se cruza por nombre y monto solo si hay UN candidato
//     claro; se marca para que quien liquida lo confirme.
//
// Nada de esto escribe: el plan es una propuesta que quien liquida revisa en
// «Reparto y liquidación» antes de aplicar.

import { isNonDeliveryReason, isPaymentMethod, NON_DELIVERY_REASONS, type PaymentMethod } from "@/lib/routes";

/** Una fila de la hoja, tal como la leyó la visión. */
export interface NotebookLine {
  /** ITEM / punto de la hoja. */
  item: number | null;
  /** PROVEEDOR: la tienda (AURELA, KENKU…). */
  store: string | null;
  customer: string | null;
  district: string | null;
  /** F. PAGO tal cual: EFECTIVO, PAGO POS, CAIDA, REPRO, LUNES… */
  written: string | null;
  /** RECAUDADO de la fila. */
  amount: number | null;
  /** GANANCIA del motorizado que anotó la hoja. */
  fee: number | null;
  /** Código del pedido (OBSERVACIÓN): #KP138029, #AUR177680. */
  order: string | null;
  /** Lo demás que diga la observación. */
  notes: string | null;
}

export type NotebookOutcome =
  | { status: "entregado"; method: PaymentMethod; amount: number }
  | { status: "no_entregado"; reason: string };

/** Lo que dice la palabra escrita, traducido al reporte de la parada. */
export interface WrittenInterpretation {
  outcome: NotebookOutcome | null;
  /** Código del dominio Reparto propio (0180), para Liquidaciones 2. */
  code: string | null;
  /** La palabra tal cual, en mayúsculas. */
  written: string;
  /** El detalle de pago escrito, cuando es una entrega. */
  payment: string | null;
  /** Día que la hoja nombra para volver («MIERCOLES»), si lo nombra. */
  day: string | null;
  /** Por qué no se pudo traducir, para pedírselo a una persona. */
  problem: string | null;
}

const DAYS = ["DOMINGO", "LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO"] as const;
const DAY_LABEL: Record<string, string> = {
  DOMINGO: "domingo", LUNES: "lunes", MARTES: "martes", MIERCOLES: "miércoles",
  JUEVES: "jueves", VIERNES: "viernes", SABADO: "sábado",
};

/** Mayúsculas, sin tildes ni signos: «Miércoles» y «MIERCOLES» son lo mismo. */
export function normalizeWord(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const delivered = (method: PaymentMethod, amount: number | null, written: string, payment: string): WrittenInterpretation => {
  if (method === "sin_cobro") {
    return { outcome: { status: "entregado", method, amount: 0 }, code: "entregado", written, payment, day: null, problem: null };
  }
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    return { outcome: null, code: "entregado", written, payment, day: null, problem: `Dice ${written} pero no se lee cuánto cobró.` };
  }
  return { outcome: { status: "entregado", method, amount }, code: "entregado", written, payment, day: null, problem: null };
};

const notDelivered = (reason: string, code: string, written: string, day: string | null = null): WrittenInterpretation => ({
  outcome: { status: "no_entregado", reason }, code, written, payment: null, day, problem: null,
});

/**
 * Traduce lo escrito en F. PAGO. El orden importa: «COBRO CAIDA» es un
 * rechazo antes que una caída, «YAPE PROV» es pagado a la tienda antes que un
 * Yape al motorizado, y «PAGO POS» es POS aunque diga «pago».
 */
export function interpretWritten(raw: string | null | undefined, amount: number | null): WrittenInterpretation {
  // «OLO ENTREGA»: la captura corta la celda, pero sigue siendo SOLO ENTREGA.
  const text = normalizeWord(raw).replace(/^OLO ENTREGA/, "SOLO ENTREGA");
  const written = text;
  if (!text) return { outcome: null, code: null, written, payment: null, day: null, problem: "La hoja no dice qué pasó." };
  if (/\bSOLO ENTREGA\b|\bYAPE PROV|\bPAGO PROV|\bPAGADO\b|\bYA PAGO\b|\bPAGO TIENDA\b/.test(text)) {
    return delivered("sin_cobro", 0, written, text);
  }
  if (/\bCOBRO CAIDA\b|\bRECHAZ/.test(text)) return notDelivered("rechazado", "rechazado", written);
  if (/\bPOS\b|\bTARJETA\b|\bIZIPAY\b|\bVISA\b/.test(text)) return delivered("pos", amount, written, text);
  if (/\bEFECTIVO\b|\bCONTADO\b|\bCASH\b/.test(text)) return delivered("efectivo", amount, written, text);
  if (/\bYAPE\b|\bPLIN\b|\bTRANSFER/.test(text)) return delivered("yape", amount, written, text);
  if (/\bCAIDA\b|\bCAYO\b|\bANULAD|\bCANCEL|\bVIAJE\b/.test(text)) return notDelivered("otro", "cancelado", written);
  if (/\bNO CONTEST|\bNO RESPOND|\bAPAGADO\b/.test(text)) return notDelivered("no_contesta", "no_responde", written);
  if (/\bNO ESTABA\b|\bAUSENTE\b|\bNADIE\b/.test(text)) return notDelivered("no_estaba", "no_recibe", written);
  if (/\bDIRECCION\b|\bDATO ERRADO\b/.test(text)) return notDelivered("direccion_errada", "dato_errado", written);
  if (/\bSIN DINERO\b|\bNO TENIA\b|\bSIN PLATA\b/.test(text)) return notDelivered("sin_dinero", "en_espera_cliente", written);
  const day = DAYS.find((d) => new RegExp(`\\b${d}\\b`).test(text)) ?? null;
  if (day) return notDelivered("reprogramado", "reprogramado", written, day);
  if (/\bREPRO|\bREAGEND|\bMANANA\b|\bOTRO DIA\b/.test(text)) return notDelivered("reprogramado", "reprogramado", written);
  return { outcome: null, code: null, written, payment: null, day: null, problem: `No sé qué significa «${written}»: elige qué pasó.` };
}

const REASON_CODE: Record<string, string> = {
  rechazado: "rechazado", otro: "cancelado", no_contesta: "no_responde", no_estaba: "no_recibe",
  direccion_errada: "dato_errado", sin_dinero: "en_espera_cliente", reprogramado: "reprogramado",
};

/** El código de Reparto propio (0180) del resultado que se carga, aunque una persona lo haya cambiado. */
export function outcomeCode(outcome: NotebookOutcome): string | null {
  return outcome.status === "entregado" ? "entregado" : REASON_CODE[outcome.reason] ?? null;
}

/** ¿Es el mismo resultado? Para saber si quien liquida cambió lo que dice la hoja. */
export function sameOutcome(a: NotebookOutcome | null, b: NotebookOutcome | null): boolean {
  if (!a || !b || a.status !== b.status) return false;
  if (a.status === "entregado" && b.status === "entregado") return a.method === b.method && Math.round(a.amount * 100) === Math.round(b.amount * 100);
  return a.status === "no_entregado" && b.status === "no_entregado" && a.reason === b.reason;
}

/** «miércoles 07/10»: el primer día con ese nombre después de la ruta. */
export function nextNamedDay(routeDate: string, day: string): string | null {
  const target = DAYS.indexOf(day as (typeof DAYS)[number]);
  if (target < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return null;
  const base = new Date(`${routeDate}T12:00:00Z`);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    if (d.getUTCDay() === target) return `${DAY_LABEL[day]} ${ddmm(d.toISOString().slice(0, 10))}`;
  }
  return null;
}

export function ddmm(isoDay: string): string {
  return `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;
}

/**
 * Los nombres de pedido que puede querer decir un código escrito. «#KP138029»,
 * «KP 138029» y «kp138029» son el mismo; un número suelto puede ser de
 * cualquiera de las dos tiendas, así que se prueban ambos prefijos.
 */
export function codeCandidates(raw: string | null | undefined): string[] {
  const compact = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) return [];
  const m = /^([A-Z]*)(\d{4,})$/.exec(compact);
  if (!m) return [];
  const [, prefix, digits] = m;
  if (prefix) return [`#${prefix}${digits}`];
  return [`#${digits}`, `#KP${digits}`, `#AUR${digits}`];
}

// ---------------------------------------------------------------------------
// El cruce con la ruta

/** Una parada de la ruta del día con lo que hace falta para cruzarla. */
export interface PlanStop {
  stopId: string;
  orderId: string;
  orderName: string | null;
  customerName: string | null;
  status: "pendiente" | "entregado" | "no_entregado" | string;
  /** Lo reportado, para decir «ya reportada: Entregado · Efectivo S/ 89». */
  reportedLabel: string | null;
  total: number | null;
  /** Saldo por cobrar (route-collection). Null si no se pudo leer. */
  remaining: number | null;
}

/** Un reprogramado que el motorizado conserva en la caja de un día anterior. */
export interface PlanCarry {
  shipmentId: string;
  orderId: string;
  orderName: string | null;
  customerName: string | null;
  fromDate: string;
  total: number | null;
  remaining: number | null;
}

/** Un pedido nombrado en la hoja que no está ni en la ruta ni para pasar. */
export interface PlanOrderElsewhere {
  orderId: string;
  orderName: string;
  cancelled: boolean;
  /** Dónde está: «en la caja de Roy del 05/10», «en ninguna caja». */
  where: string;
}

export interface NotebookContext {
  routeDate: string;
  riderName: string;
  stops: PlanStop[];
  carry: PlanCarry[];
  /** Por nombre de pedido normalizado (#KP138029). */
  elsewhere: Map<string, PlanOrderElsewhere>;
}

export type MatchKind = "pendiente" | "reportada" | "arrastre" | "anulado" | "otra_caja" | "no_existe" | "sin_codigo";

export type NotebookAction = "reportar" | "pasar_y_reportar" | "omitir";

export interface PlanRow {
  /** Posición de la fila en la hoja (0, 1, 2…), estable entre leer y aplicar. */
  index: number;
  line: NotebookLine;
  match: {
    kind: MatchKind;
    via: "codigo" | "nombre" | null;
    orderId: string | null;
    orderName: string | null;
    stopId: string | null;
    shipmentId: string | null;
    fromDate: string | null;
    detail: string | null;
  };
  interpretation: WrittenInterpretation;
  action: NotebookAction;
  outcome: NotebookOutcome | null;
  warnings: string[];
}

export interface NotebookPlan {
  rows: PlanRow[];
  /** Paradas pendientes de la ruta que la hoja no menciona. */
  missing: { stopId: string; orderName: string | null; customerName: string | null }[];
  totals: {
    sheetAmount: number;
    sheetFee: number;
    declaredAmount: number | null;
    declaredFee: number | null;
    /** ¿Las filas suman lo que dice el TOTAL de la hoja? Null sin total. */
    matchesDeclared: boolean | null;
    loadCash: number;
    loadPos: number;
    loadYape: number;
    /** Plata anotada en filas que no se cargan (fuera de la ruta). */
    notLoadedAmount: number;
  };
}

function nameTokens(name: string | null | undefined): string[] {
  return normalizeWord(name).split(" ").filter((t) => t.length >= 3);
}

/**
 * ¿Qué tan parecido es el nombre de la hoja («Clay Sena Caya») al del pedido?
 * Fracción de palabras de la hoja que aparecen en el pedido (o empiezan igual:
 * la hoja abrevia, «Gisenia Cayc.» → «Gisenia Caycho»).
 */
export function nameScore(sheet: string | null | undefined, order: string | null | undefined): number {
  const a = nameTokens(sheet);
  const b = nameTokens(order);
  if (!a.length || !b.length) return 0;
  const hits = a.filter((t) => b.some((u) => u === t || u.startsWith(t) || t.startsWith(u))).length;
  return hits / a.length;
}

const cents = (n: number) => Math.round(n * 100);
const sameMoney = (a: number | null, b: number | null) => a !== null && b !== null && cents(a) === cents(b);

/** «Entregado · Efectivo S/ 89.00», para filas y avisos. */
export function outcomeLabel(outcome: NotebookOutcome | null): string {
  if (!outcome) return "Sin decidir";
  if (outcome.status === "entregado") {
    const method = { efectivo: "Efectivo", pos: "POS", yape: "Yape", sin_cobro: "Sin cobro" }[outcome.method];
    return outcome.method === "sin_cobro" ? `Entregado · ${method}` : `Entregado · ${method} S/ ${outcome.amount.toFixed(2)}`;
  }
  const reason = NON_DELIVERY_REASONS.find((r) => r.code === outcome.reason)?.label ?? outcome.reason;
  return `No entregado · ${reason}`;
}

/** Avisos de plata de una entrega: cobro parcial, de más, o «sin cobro» con saldo. */
function moneyWarnings(outcome: NotebookOutcome | null, total: number | null, remaining: number | null): string[] {
  if (!outcome || outcome.status !== "entregado") return [];
  const owed = remaining ?? total;
  if (outcome.method === "sin_cobro") {
    return remaining !== null && remaining > 0
      ? [`El pedido tiene saldo S/ ${remaining.toFixed(2)}: «Sin cobro» no lo marca pagado.`]
      : [];
  }
  if (owed === null) return [];
  if (cents(outcome.amount) > cents(owed)) {
    return [`Cobró S/ ${outcome.amount.toFixed(2)} y el saldo es S/ ${owed.toFixed(2)}: no se puede registrar más que el saldo.`];
  }
  if (cents(outcome.amount) < cents(owed)) {
    return [`Cobró S/ ${outcome.amount.toFixed(2)} de S/ ${owed.toFixed(2)}; la hoja no dice por qué.`];
  }
  return [];
}

/**
 * Cruza la hoja con la ruta y propone qué hacer con cada fila. `declared` son
 * los totales que la hoja escribe abajo (TOTAL COBRADO), si los trae.
 */
export function buildNotebookPlan(
  lines: readonly NotebookLine[],
  ctx: NotebookContext,
  declared: { amount: number | null; fee: number | null } = { amount: null, fee: null },
): NotebookPlan {
  const stopsByName = new Map<string, PlanStop>();
  for (const s of ctx.stops) if (s.orderName) stopsByName.set(s.orderName.toUpperCase(), s);
  const carryByName = new Map<string, PlanCarry>();
  for (const c of ctx.carry) if (c.orderName) carryByName.set(c.orderName.toUpperCase(), c);
  const usedOrders = new Set<string>();

  // Primera pasada: por código. Lo que se cruza así no puede volver a tomarse
  // por nombre en la segunda.
  const byCode: (PlanRow["match"] | null)[] = lines.map((line) => {
    for (const name of codeCandidates(line.order)) {
      const stop = stopsByName.get(name);
      if (stop) {
        usedOrders.add(stop.orderId);
        return {
          kind: stop.status === "pendiente" ? "pendiente" : "reportada", via: "codigo", orderId: stop.orderId,
          orderName: stop.orderName, stopId: stop.stopId, shipmentId: null, fromDate: null,
          detail: stop.status === "pendiente" ? null : `Ya reportada: ${stop.reportedLabel ?? stop.status}.`,
        } as PlanRow["match"];
      }
      const carry = carryByName.get(name);
      if (carry) {
        usedOrders.add(carry.orderId);
        return {
          kind: "arrastre", via: "codigo", orderId: carry.orderId, orderName: carry.orderName, stopId: null,
          shipmentId: carry.shipmentId, fromDate: carry.fromDate,
          detail: `Reprogramado el ${ddmm(carry.fromDate)}; sigue con ${ctx.riderName}. Pasa a esta ruta, ya cotejado.`,
        } as PlanRow["match"];
      }
      const other = ctx.elsewhere.get(name);
      if (other) {
        return {
          kind: other.cancelled ? "anulado" : "otra_caja", via: "codigo", orderId: other.orderId, orderName: other.orderName,
          stopId: null, shipmentId: null, fromDate: null,
          detail: other.cancelled
            ? `Anulado en Shopify: no se carga; si ${ctx.riderName} tiene el paquete, vuelve a la oficina (${other.where}).`
            : `No está en esta ruta: ${other.where}.`,
        } as PlanRow["match"];
      }
    }
    return null;
  });

  // Segunda pasada: sin código (o con uno que no existe), por nombre y monto
  // entre lo que queda pendiente o para pasar. Solo con un candidato claro.
  const rows: PlanRow[] = lines.map((line, index) => {
    const interpretation = interpretWritten(line.written, line.amount);
    let match = byCode[index];
    if (!match) {
      const hadCode = codeCandidates(line.order).length > 0;
      const pool = [
        ...ctx.stops.filter((s) => s.status === "pendiente" && !usedOrders.has(s.orderId)).map((s) => ({ kind: "pendiente" as const, s, c: null as PlanCarry | null })),
        ...ctx.carry.filter((c) => !usedOrders.has(c.orderId)).map((c) => ({ kind: "arrastre" as const, s: null as PlanStop | null, c })),
      ];
      const scored = pool
        .map((p) => {
          const name = p.s?.customerName ?? p.c?.customerName ?? null;
          const total = p.s?.total ?? p.c?.total ?? null;
          const remaining = p.s?.remaining ?? p.c?.remaining ?? null;
          const amountHit = line.amount !== null && line.amount > 0 && (sameMoney(line.amount, total) || sameMoney(line.amount, remaining));
          return { p, score: nameScore(line.customer, name) + (amountHit ? 0.25 : 0) };
        })
        .filter((x) => x.score >= 0.75)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const unique = best && (scored.length === 1 || scored[1]!.score < best.score);
      if (best && unique) {
        const id = best.p.s?.orderId ?? best.p.c!.orderId;
        usedOrders.add(id);
        match = best.p.s
          ? { kind: "pendiente", via: "nombre", orderId: id, orderName: best.p.s.orderName, stopId: best.p.s.stopId, shipmentId: null, fromDate: null,
              detail: `Cruzado por nombre${hadCode ? " (el código de la hoja no existe)" : " (la hoja no trae código)"}: confírmalo.` }
          : { kind: "arrastre", via: "nombre", orderId: id, orderName: best.p.c!.orderName, stopId: null, shipmentId: best.p.c!.shipmentId,
              fromDate: best.p.c!.fromDate,
              detail: `Cruzado por nombre: reprogramado el ${ddmm(best.p.c!.fromDate)}, sigue con ${ctx.riderName}. Confírmalo.` };
      } else {
        match = {
          kind: hadCode ? "no_existe" : "sin_codigo", via: null, orderId: null, orderName: null, stopId: null, shipmentId: null, fromDate: null,
          detail: hadCode
            ? `El código ${line.order} no es un pedido de la tienda.`
            : "La hoja no trae código y el nombre no coincide con ninguna parada.",
        };
      }
    }

    const target = match.stopId
      ? ctx.stops.find((s) => s.stopId === match!.stopId) ?? null
      : match.shipmentId
        ? ctx.carry.find((c) => c.shipmentId === match!.shipmentId) ?? null
        : null;
    const warnings: string[] = [];
    if (match.detail && (match.kind !== "pendiente" || match.via === "nombre")) warnings.push(match.detail);
    const loadable = match.kind === "pendiente" || match.kind === "arrastre";
    if (loadable && interpretation.problem) warnings.push(interpretation.problem);
    if (loadable) warnings.push(...moneyWarnings(interpretation.outcome, target?.total ?? null, target?.remaining ?? null));
    if (interpretation.outcome?.status === "no_entregado" && line.amount !== null && line.amount > 0) {
      warnings.push(`La hoja anota S/ ${line.amount.toFixed(2)} en un ${interpretation.written}: no se registra cobro.`);
    }
    const overpaid = warnings.some((w) => w.includes("no se puede registrar más"));
    const action: NotebookAction = !loadable || !interpretation.outcome || overpaid
      ? "omitir"
      : match.kind === "arrastre" ? "pasar_y_reportar" : "reportar";
    return { index, line, match, interpretation, action, outcome: interpretation.outcome, warnings };
  });

  const named = new Set(rows.map((r) => r.match.stopId).filter(Boolean));
  const missing = ctx.stops
    .filter((s) => s.status === "pendiente" && !named.has(s.stopId))
    .map((s) => ({ stopId: s.stopId, orderName: s.orderName, customerName: s.customerName }));

  return { rows, missing, totals: planTotals(rows, declared) };
}

/** Los totales de la hoja y de lo que se va a cargar. Se recalculan al editar. */
export function planTotals(rows: readonly PlanRow[], declared: { amount: number | null; fee: number | null }): NotebookPlan["totals"] {
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  const sheetAmount = round2(sum(rows.map((r) => r.line.amount)));
  const sheetFee = round2(sum(rows.map((r) => r.line.fee)));
  const load = (method: PaymentMethod) => round2(sum(rows.map((r) =>
    r.action !== "omitir" && r.outcome?.status === "entregado" && r.outcome.method === method ? r.outcome.amount : 0)));
  const matchesAmount = declared.amount === null ? null : cents(declared.amount) === cents(sheetAmount);
  const matchesFee = declared.fee === null ? null : cents(declared.fee) === cents(sheetFee);
  return {
    sheetAmount,
    sheetFee,
    declaredAmount: declared.amount,
    declaredFee: declared.fee,
    matchesDeclared: matchesAmount === null && matchesFee === null ? null : matchesAmount !== false && matchesFee !== false,
    loadCash: load("efectivo"),
    loadPos: load("pos"),
    loadYape: load("yape"),
    notLoadedAmount: round2(sum(rows.map((r) => (r.action === "omitir" ? r.line.amount : 0)))),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * La nota de la parada: de dónde salió el reporte, quién lo cargó y lo que la
 * palabra escrita no dice sola. Es la misma forma que las cargas a mano del
 * 01 al 06/10, para que las paradas se lean igual.
 */
export function notebookStopNote(input: {
  riderName: string;
  routeDate: string;
  row: Pick<PlanRow, "line" | "interpretation" | "match" | "warnings">;
  outcome: NotebookOutcome;
  loadedBy: string;
  loadedOn: string;
}): string {
  const { riderName, routeDate, row, outcome } = input;
  const point = row.line.item !== null ? ` (punto ${row.line.item})` : "";
  const parts = [
    `Cuaderno de ${riderName} del ${ddmm(routeDate)}${point}: aún no usa la app, va sin foto. Cargado por ${input.loadedBy} el ${ddmm(input.loadedOn)}.`,
  ];
  if (row.match.kind === "arrastre" && row.match.fromDate) {
    parts.push(`Lo traía desde su ruta del ${ddmm(row.match.fromDate)} (reprogramado) y salió en la del ${ddmm(routeDate)}.`);
  }
  if (row.match.via === "nombre") {
    parts.push(`La hoja no trae el código; se cruzó por el nombre (${row.line.customer ?? "sin nombre"})${row.line.amount ? ` y el monto (S/ ${row.line.amount.toFixed(2)})` : ""}.`);
  }
  const written = row.interpretation.written;
  if (outcome.status === "entregado" && outcome.method === "sin_cobro") {
    parts.push(`${written} en el cuaderno: el pedido ya estaba pagado y no se cobró nada.`);
  } else if (outcome.status === "no_entregado" && outcome.reason === "otro") {
    parts.push(`${written} en el cuaderno: no se paga ni se le cobra a la tienda.`);
  } else if (outcome.status === "no_entregado" && outcome.reason === "reprogramado" && row.interpretation.day) {
    const when = nextNamedDay(routeDate, row.interpretation.day);
    parts.push(`${written} en el cuaderno: reprogramado para el ${when ?? DAY_LABEL[row.interpretation.day]}.`);
  }
  if (row.interpretation.outcome && !sameOutcome(row.interpretation.outcome, outcome)) {
    parts.push(`La hoja dice ${written || "nada"} (${outcomeLabel(row.interpretation.outcome)}); quien cargó lo dejó como ${outcomeLabel(outcome)}.`);
  } else if (!row.interpretation.outcome) {
    parts.push(`La hoja dice ${written ? `«${written}»` : "nada"}; quien cargó eligió ${outcomeLabel(outcome)}.`);
  }
  for (const w of row.warnings) if (w.startsWith("Cobró S/") && w.includes(" de S/ ")) parts.push(w);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Lo que manda la pantalla al aplicar

export interface NotebookDecision {
  index: number;
  action: NotebookAction;
  outcome: NotebookOutcome | null;
  /** Para una fila sin código: la parada pendiente que quien liquida eligió. */
  stopId?: string | null;
}

const ACTIONS = new Set<NotebookAction>(["reportar", "pasar_y_reportar", "omitir"]);

/** Un resultado bien formado, o null. La UI lo arma; el servidor no se fía. */
export function cleanOutcome(raw: unknown): NotebookOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.status === "entregado") {
    if (!isPaymentMethod(typeof o.method === "string" ? o.method : null)) return null;
    const method = o.method as "efectivo" | "pos" | "yape" | "sin_cobro";
    const amount = typeof o.amount === "number" && Number.isFinite(o.amount) ? Math.round(o.amount * 100) / 100 : NaN;
    if (method === "sin_cobro") return { status: "entregado", method, amount: 0 };
    return amount > 0 ? { status: "entregado", method, amount } : null;
  }
  if (o.status === "no_entregado" && typeof o.reason === "string" && isNonDeliveryReason(o.reason)) {
    return { status: "no_entregado", reason: o.reason };
  }
  return null;
}

export function cleanDecisions(raw: unknown): NotebookDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: NotebookDecision[] = [];
  for (const d of raw.slice(0, 200)) {
    if (!d || typeof d !== "object") continue;
    const x = d as Record<string, unknown>;
    if (typeof x.index !== "number" || !Number.isInteger(x.index) || x.index < 0) continue;
    const action = typeof x.action === "string" && ACTIONS.has(x.action as NotebookAction) ? (x.action as NotebookAction) : "omitir";
    out.push({ index: x.index, action, outcome: cleanOutcome(x.outcome), stopId: typeof x.stopId === "string" && x.stopId ? x.stopId : null });
  }
  return out;
}

