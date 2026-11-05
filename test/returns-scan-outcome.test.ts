// Devoluciones: el contador por tanda, la línea de Grupo GF y los colores de
// cada lectura (05-11-2026, MOM §9.4 y §29.13). En producción la cámara decía
// «Recibidas 346 de 608 · faltan 262» —solo Tanders y Shalom, un atraso desde
// septiembre— y no contaba las 26 cajas de Grupo GF del día; y KP201949-S01,
// recibida a las 16:45 y escaneada otra vez, salía en verde como si sumara.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  courierReceptionOutcome,
  earliestOccurredAt,
  gfReceivedWhenRemoved,
  gfReceptionLine,
  historicReceptionLine,
  latestOccurredAt,
  limaDayKey,
  receivedWhenText,
  recordReturnScan,
  returnScanKind,
  returnScanLine,
  returnScanTallyText,
  tallyReturnScans,
} from "@/lib/returns-scan-outcome";
import { countGfReceivedToday, decideReception } from "@/lib/returns-reception";
import { decideShalomReception } from "@/lib/shalom/return-reception";
import { scanFeedbackVibration } from "@/lib/scan-progress";

const read = (path: string) => readFileSync(path, "utf8");
// 05-11-2026 18:00 en Lima.
const NOW = new Date("2026-11-05T23:00:00Z");

describe("courierReceptionOutcome: Tanders y Shalom", () => {
  const SALIO = { delivery_status: "en_ruta", custody_state: "retorno", returned_at: null };
  it("recibirla es nueva; «ya recibida» es repetida; el resto, error", () => {
    expect(courierReceptionOutcome(decideReception(SALIO, false))).toBe("nueva");
    expect(courierReceptionOutcome(decideReception(SALIO, true))).toBe("repetida");
    expect(courierReceptionOutcome(decideReception({ ...SALIO, delivery_status: "entregado" }, false))).toBeNull();
    expect(courierReceptionOutcome(decideReception({ delivery_status: "pendiente", custody_state: "empresa", returned_at: null }, false))).toBeNull();
  });

  it("Shalom igual", () => {
    const guide = { delivery_status: "anulado", custody_state: "retorno", returned_at: null, pickup_state: "retorno_iniciado", dispatched_at: null, out_for_delivery_at: null };
    const keys = { hasKey: true, keyGiven: false };
    expect(courierReceptionOutcome(decideShalomReception(guide, keys, false))).toBe("nueva");
    expect(courierReceptionOutcome(decideShalomReception(guide, keys, true))).toBe("repetida");
    expect(courierReceptionOutcome(decideShalomReception({ ...guide, delivery_status: "entregado" }, { hasKey: false, keyGiven: false }, false))).toBeNull();
  });
});

describe("cuándo se recibió por primera vez", () => {
  it("el evento más antiguo; sin eventos, el respaldo", () => {
    expect(earliestOccurredAt([{ occurred_at: "2026-11-05T23:00:00Z" }, { occurred_at: "2026-11-05T21:45:00Z" }, { occurred_at: null }])).toBe("2026-11-05T21:45:00Z");
    expect(earliestOccurredAt([], "2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00Z");
    expect(earliestOccurredAt(null)).toBeNull();
  });

  it("Grupo GF: la más reciente, porque la salida conserva su id de vuelta en vuelta", () => {
    expect(latestOccurredAt([{ occurred_at: "2026-10-28T15:00:00Z" }, { occurred_at: "2026-11-05T21:45:00Z" }, { occurred_at: null }])).toBe("2026-11-05T21:45:00Z");
    expect(latestOccurredAt([], "2026-10-01T00:00:00Z")).toBe("2026-10-01T00:00:00Z");
    expect(latestOccurredAt(undefined)).toBeNull();
  });

  it("dos lecturas a la vez: la recepción de la otra va con la salida de la caja (misma transacción)", () => {
    expect(gfReceivedWhenRemoved("2026-11-05T21:45:00Z", "2026-11-05T21:45:00Z")).toBe(true);
    expect(gfReceivedWhenRemoved("2026-11-05T21:45:00Z", "2026-11-05T21:44:58Z")).toBe(true);
    // Una recepción de una vuelta anterior no explica que la caja la soltara hoy.
    expect(gfReceivedWhenRemoved("2026-11-05T21:45:00Z", "2026-10-28T15:00:00Z")).toBe(false);
    expect(gfReceivedWhenRemoved(null, "2026-11-05T21:45:00Z")).toBe(false);
    expect(gfReceivedWhenRemoved("2026-11-05T21:45:00Z", null)).toBe(false);
  });

  it("dice «hoy 16:45», «ayer …» o la fecha, en hora de Lima", () => {
    expect(receivedWhenText("2026-11-05T21:45:00Z", NOW)).toBe("hoy 16:45");
    expect(receivedWhenText("2026-11-04T14:10:00Z", NOW)).toBe("ayer 09:10");
    expect(receivedWhenText("2026-11-01T14:10:00Z", NOW)).toBe("el 01/11 09:10");
    // 00:30 del 05 en UTC es todavía el 04 en Lima.
    expect(receivedWhenText("2026-11-05T00:30:00Z", NOW)).toBe("ayer 19:30");
    expect(receivedWhenText(null, NOW)).toBeNull();
  });
});

describe("returnScanLine: el color y el texto de cada lectura", () => {
  it("nueva: verde, «recibida ✓», con el aviso debajo", () => {
    const line = returnScanLine({ notice: "KP1-S01 recibido en oficina: vuelve a «por asignar»…", reception: { outcome: "nueva", courier: "grupo_gf", label: "KP1-S01" } }, NOW);
    expect(line).toEqual({ kind: "nueva", tone: "ok", headline: "KP1-S01 · recibida ✓", detail: "KP1-S01 recibido en oficina: vuelve a «por asignar»…" });
  });

  it("#KP201949 repetida: ámbar, «ya estaba recibida (hoy 16:45) · no suma»", () => {
    const line = returnScanLine({
      notice: "KP201949-S01 ya estaba recibido en oficina: sigue por asignar en Grupo GF para reprogramarlo.",
      reception: { outcome: "repetida", courier: "grupo_gf", label: "KP201949-S01", firstReceivedAt: "2026-11-05T21:45:00Z" },
    }, NOW);
    expect(line.kind).toBe("repetida");
    expect(line.tone).toBe("warn");
    expect(line.headline).toBe("KP201949-S01 · ya estaba recibida (hoy 16:45) · no suma");
    expect(line.detail).toContain("sigue por asignar");
  });

  it("repetida sin hora conocida igual dice «no suma»", () => {
    expect(returnScanLine({ notice: "x", reception: { outcome: "repetida", courier: "tanders", label: "TD1", firstReceivedAt: null } }, NOW).headline).toBe("TD1 · ya estaba recibida · no suma");
  });

  it("informativa: neutro, el aviso tal cual", () => {
    const notice = "KP137351-S01 nunca salió en Kapta: no hay devolución que registrar. Sigue por asignar en Grupo GF.";
    expect(returnScanLine({ notice, reception: { outcome: "informativa", courier: "grupo_gf", label: "KP137351-S01" } }, NOW)).toEqual({ kind: "informativa", tone: "neutral", headline: notice, detail: null });
  });

  it("error: rojo; y una caja recibida con aviso rojo suma pero se pinta en rojo", () => {
    expect(returnScanLine({ error: "No encontramos esa caja." }, NOW)).toEqual({ kind: "error", tone: "crit", headline: "No encontramos esa caja.", detail: null });
    const alert = returnScanLine({ error: "KP1-S01 recibido en oficina. Está ANULADO: no sale.", reception: { outcome: "nueva", courier: "grupo_gf", label: "KP1-S01" } }, NOW);
    expect(alert).toMatchObject({ kind: "nueva", tone: "crit", headline: "KP1-S01 · recibida ✓" });
    expect(returnScanKind({ notice: "Listo." })).toBe("informativa");
  });

  it("una informativa con aviso rojo («nunca salió» de un pedido anulado) no recibió nada: es error", () => {
    const result = { error: "Pedido #KP1 ANULADO: no lo despaches.", reception: { outcome: "informativa" as const, courier: "grupo_gf" as const, label: "KP1-S01" } };
    expect(returnScanKind(result)).toBe("error");
    expect(returnScanLine(result, NOW)).toMatchObject({ kind: "error", tone: "crit" });
    // Una repetida con aviso rojo sigue sin sumar: repetida.
    expect(returnScanKind({ error: "x", reception: { outcome: "repetida", courier: "grupo_gf", label: "KP1-S01" } })).toBe("repetida");
  });
});

describe("la tanda", () => {
  it("cuenta cada lectura una vez y solo dice lo que no es cero", () => {
    expect(returnScanTallyText(tallyReturnScans([]))).toBe("Esta tanda: 0 recibidas");
    expect(returnScanTallyText(tallyReturnScans(["nueva"]))).toBe("Esta tanda: 1 recibida");
    const t = tallyReturnScans(["nueva", "nueva", "repetida", "error", "informativa", "nueva", "error"]);
    expect(t).toEqual({ nuevas: 3, repetidas: 1, informativas: 1, errores: 2 });
    expect(returnScanTallyText(t)).toBe("Esta tanda: 3 recibidas · 1 repetida · 2 con error · 1 sin devolución");
  });

  it("la línea de Grupo GF y la del atraso histórico", () => {
    const today = "2026-11-05";
    const box = (routeDate: string) => ({ routeDate });
    expect(gfReceptionLine({ recibidasHoy: 26, pendientes: [box(today), box(today), box("2026-11-04"), box("2026-10-30")], today })).toBe(
      "Grupo GF: 26 recibidas hoy · 4 siguen en cajas (2 de días anteriores)",
    );
    expect(gfReceptionLine({ recibidasHoy: 3, pendientes: [box(today)], today })).toBe("Grupo GF: 3 recibidas hoy · 1 sigue en cajas");
    expect(gfReceptionLine({ recibidasHoy: 1, pendientes: [], today })).toBe("Grupo GF: 1 recibida hoy · ninguna en cajas");
    // Lunes temprano con lo de la semana pasada: no se lee como «0 de 7» de hoy.
    const monday = gfReceptionLine({ recibidasHoy: 0, pendientes: Array.from({ length: 7 }, () => box("2026-10-30")), today });
    expect(monday).toBe("Grupo GF: 0 recibidas hoy · 7 siguen en cajas (todas de días anteriores)");
    expect(monday).not.toMatch(/ de 7/);
    expect(gfReceptionLine({ recibidasHoy: 0, pendientes: [box("2026-10-30")], today })).toBe("Grupo GF: 0 recibidas hoy · 1 sigue en cajas (de días anteriores)");
    expect(limaDayKey(NOW)).toBe("2026-11-05");
    expect(limaDayKey(new Date("2026-11-06T04:30:00Z"))).toBe("2026-11-05");
    expect(historicReceptionLine({ done: 346, total: 608 })).toBe("Tanders y Shalom (pendientes históricos): 346 de 608 · faltan 262");
    expect(historicReceptionLine({ done: 2, total: 2 })).toBe("Tanders y Shalom (pendientes históricos): 2 de 2 · no falta ninguna");
  });

  it("lo recibido hoy de Grupo GF: una vez por salida, sin «Mover» en la oficina", () => {
    expect(countGfReceivedToday([
      { shipment_id: "a", payload: {} },
      { shipment_id: "a", payload: null },
      { shipment_id: "b" },
      { shipment_id: "c", payload: { reclaimed_in_office: true } },
      { shipment_id: null, payload: {} },
    ])).toBe(3);
  });

  it("un corte de red y su reintento «ya estaba recibida» de esta tanda cuentan UNA recibida", () => {
    const start = Date.parse("2026-11-05T21:40:00Z");
    const cut = recordReturnScan([], { id: 1, code: "KP201949-S01", result: { error: "No llegó la respuesta." }, transport: true }, start, NOW);
    expect(cut).toMatchObject([{ id: 1, transport: true, line: { kind: "error" } }]);
    const retry = recordReturnScan(cut, {
      id: 2,
      code: "kp201949-s01",
      result: { notice: "ya", reception: { outcome: "repetida", courier: "grupo_gf", label: "KP201949-S01", firstReceivedAt: "2026-11-05T21:45:00Z" } },
    }, start, NOW);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ id: 2, line: { kind: "nueva", tone: "ok", headline: "KP201949-S01 · recibida ✓" } });
    expect(tallyReturnScans(retry.map((e) => e.line.kind))).toEqual({ nuevas: 1, repetidas: 0, informativas: 0, errores: 0 });
  });

  it("…pero una repetida de antes de la tanda, o sin corte previo, sigue siendo repetida", () => {
    const start = Date.parse("2026-11-05T22:00:00Z");
    const repeat = { notice: "ya", reception: { outcome: "repetida" as const, courier: "grupo_gf" as const, label: "KP1-S01", firstReceivedAt: "2026-11-05T21:45:00Z" } };
    const cut = recordReturnScan([], { id: 1, code: "KP1-S01", result: { error: "x" }, transport: true }, start, NOW);
    expect(recordReturnScan(cut, { id: 2, code: "KP1-S01", result: repeat }, start, NOW).map((e) => e.line.kind)).toEqual(["repetida", "error"]);
    // Un error del servidor (no un corte) no se reinterpreta.
    const serverError = recordReturnScan([], { id: 1, code: "KP1-S01", result: { error: "No está en una caja." } }, 0, NOW);
    expect(recordReturnScan(serverError, { id: 2, code: "KP1-S01", result: repeat }, 0, NOW).map((e) => e.line.kind)).toEqual(["repetida", "error"]);
  });

  it("vibra distinto la repetida (dos pulsos) y el error (dos largos)", () => {
    expect(scanFeedbackVibration("warn")).toEqual([60, 90, 60]);
    expect(scanFeedbackVibration("crit")).toEqual([220, 100, 220]);
    expect(scanFeedbackVibration("ok")).toBeNull();
    expect(scanFeedbackVibration("neutral")).toBeNull();
  });
});

describe("la cámara, compatible con quien ya la usa", () => {
  const camera = read("components/dispatch-camera.tsx");

  it("lo nuevo es opcional: `tone`, `detail`, `extraLines` y `feedback`", () => {
    expect(camera).toContain("tone?: ScanStatusTone;");
    expect(camera).toContain("detail?: string | null;");
    expect(camera).toContain("extraLines?: readonly { text: string; tone?: \"ok\" | \"warn\" | \"neutral\" }[];");
    expect(camera).toContain("feedback = null,");
    // Sin `tone`, el color de siempre por `warn` / `ok`.
    expect(camera).toContain('status.tone ? STATUS_TONE_CLASS[status.tone] : status.warn ? "border-amber-200 bg-amber-50 text-amber-900" : status.ok');
  });

  it("el cierre automático no cambia: solo con `progress` y su total", () => {
    expect(camera).toContain("const finished = Boolean(continuous && pending === 0 && issues.length === 0 && progress && scanProgressDone(progress));");
    expect(camera).not.toMatch(/finished[^\n]*extraLines/);
  });

  it("la vibración extra es de mejor esfuerzo y no vuelve a vibrar en cada render", () => {
    expect(camera).toContain('if (typeof window.navigator.vibrate === "function") window.navigator.vibrate(pattern);');
    expect(camera).toContain("}, [open, feedbackKey, feedbackTone]);");
    // Una vez por resultado: reabrir la cámara con el mismo último resultado no vuelve a vibrar.
    expect(camera).toContain("if (feedbackKey === feedbackSeen.current) return;");
    expect(camera).toContain("feedbackSeen.current = feedbackKey;");
    expect(camera).toContain("window.navigator.vibrate?.(80);");
  });

  it("las demás pantallas no pasan nada nuevo", () => {
    for (const file of [
      "components/scan-action.tsx",
      "components/dispatch-workspace.tsx",
      "components/warehouse-station.tsx",
      "components/warehouse-swayp-handover.tsx",
    ]) {
      const src = read(file);
      expect(src, file).not.toContain("extraLines=");
      expect(src, file).not.toContain("feedback={");
    }
  });
});

describe("Devoluciones: la pantalla", () => {
  const screen = read("components/returns-reception.tsx");

  it("la cámara cuenta la tanda, sin total: no se cierra sola con el atraso histórico", () => {
    expect(screen).toContain("progress={{ done: tally.nuevas, label: returnScanTallyText(tally) }}");
    expect(screen).not.toContain('verb: "Recibidas"');
    expect(screen).toContain("{ text: gfLine, tone: gf.pendientes.length ? \"neutral\" : \"ok\" },");
    expect(screen).toContain("{ text: historicReceptionLine(historic) },");
    expect(screen).toContain("feedback={last ? { key: last.id, tone: last.line.tone } : null}");
  });

  it("cada lectura se cuenta una vez, al llegar su respuesta, y la lista enseña las últimas 30", () => {
    expect(screen).toContain("setScans((current) => recordReturnScan(current, { id, code: value, result, transport }, sessionStart));");
    expect(screen).toContain("const SCAN_LIST_MAX = 30;");
    expect(screen).toContain("scans.slice(0, SCAN_LIST_MAX)");
    expect(screen).toContain("<GfReturns pendientes={gf.pendientes} recibidasHoy={gf.recibidasHoy} />");
  });

  it("una lectura que llega mientras otra se procesa se encola, y el cuadre se recarga sin bloquear", () => {
    expect(screen).toContain("if (busyRef.current) {");
    expect(screen).toContain("queueRef.current.push(value);");
    expect(screen).toContain("next = queueRef.current.shift();");
    expect(screen).toContain("void reload();");
    expect(screen).toContain("if (seq !== reloadSeq.current) return;");
  });

  it("la lista no repite por lector de pantalla lo que ya anuncia el aviso; la informativa es neutra en todas partes", () => {
    expect(screen).not.toContain('aria-live="polite"');
    expect(screen).toContain('neutral: "neutral", crit: "crit" };');
    expect(read("components/ops-ui.tsx")).toContain('neutral: { wash: "bg-wash", fg: "text-ink-900", icon: IconInfo },');
  });

  it("la recarga del cuadre pide el permiso de Almacén", () => {
    const action = read("app/dashboard/pedidos/devoluciones/actions.ts");
    expect(action).toContain("if (!perms.can(RETURN_MANIFEST_PERMISSION)) return { error: \"No tienes acceso al almacén.\" };");
  });
});

describe("Despacho del día → «Devoluciones»: la repetida en ámbar, y sale de la lista", () => {
  it("solo cuando el aviso empieza por «ya estaba recibida»", () => {
    const scanner = read("components/returns-scanner.tsx");
    expect(scanner).toContain("const repeat = !res.error && /^\\d+ salidas? ya estaban? recibidas? en oficina/i.test(res.notice ?? \"\");");
    expect(scanner).toContain('<Badge tone={l.repeat ? "warn" : l.ok ? "ok" : "crit"}');
    expect(scanner).toContain("status={last ? { ok: last.ok, warn: last.repeat, text: `${last.code}: ${last.text}` } : null}");
    // Cuenta en «Devueltos X de N» (la caja ya está en la oficina): no dice «no suma».
    expect(scanner).toContain("`${res.notice} · sale de la lista`");
    expect(scanner).not.toContain("no suma");
    const repeat = /^\d+ salidas? ya estaban? recibidas? en oficina/i;
    expect(repeat.test("1 salida ya estaba recibida en oficina. No se registra otra devolución.")).toBe(true);
    expect(repeat.test("1 pedido recibido en oficina. Vuelven a «por asignar». 1 salida ya estaba recibida en oficina.")).toBe(false);
  });
});

// Tanders por la acción real, con la base de mentira.
const state = vi.hoisted(() => ({
  guide: { delivery_status: "en_ruta", custody_state: "retorno", returned_at: "2026-09-20T15:00:00Z" } as Record<string, unknown>,
  receivedAt: [] as string[],
  writes: [] as { table: string; op: string }[],
  /** Filas que devuelve el sello (`update … .select("id")`): 0 = otra lectura selló antes. */
  sealedRows: 1,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect login"); } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async () => {} }));
vi.mock("@/lib/db", () => {
  const SHIPMENT = {
    id: "ship-1", store_id: "store-1", courier: "tanders", guide_code: "TD9001", output_number: 1,
    output_code: "KP201000-S01", qr_token: null, preparation_state: "listo_despacho", custody_state: "retorno",
    ready_at: null, order_id: "order-1", order_name: "#KP201000", customer_name: null, customer_phone: null,
    district: null, province: null, product: null,
  };
  const from = (client: "user" | "admin", table: string) => {
    let op = "select";
    const reply = () => {
      if (op === "update" && table === "shipments") return { data: Array.from({ length: state.sealedRows }, () => ({ id: "ship-1" })), error: null };
      if (op !== "select") return { data: null, error: null };
      if (table === "shipments") return { data: client === "user" ? [SHIPMENT] : state.guide, error: null };
      if (table === "stores") return { data: { org_id: "org-1" }, error: null };
      if (table === "order_events") return { data: state.receivedAt.map((at, i) => ({ id: `e${i}`, occurred_at: at })), error: null };
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "ilike", "limit", "or", "order"]) q[m] = () => q;
    q.update = () => { op = "update"; state.writes.push({ table, op }); return q; };
    q.insert = () => { op = "insert"; state.writes.push({ table, op }); return q; };
    q.maybeSingle = q.single = async () => reply();
    q.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(reply()).then(resolve, reject);
    return q;
  };
  return {
    createServerSupabase: async () => ({ from: (table: string) => from("user", table), auth: { getUser: async () => ({ data: { user: { id: "persona" } } }) } }),
    createAdminSupabase: () => ({ from: (table: string) => from("admin", table) }),
  };
});

import { receiveReturnedPackage } from "@/app/dashboard/pedidos/despacho/actions";

beforeEach(() => {
  Object.assign(state, {
    guide: { delivery_status: "en_ruta", custody_state: "retorno", returned_at: "2026-09-20T15:00:00Z" },
    receivedAt: [],
    writes: [],
    sealedRows: 1,
  });
});

describe("receiveReturnedPackage con una caja de Tanders", () => {
  it("la recibe: nueva", async () => {
    const result = await receiveReturnedPackage("KP201000-S01");
    expect(result.notice).toBe("KP201000-S01 recibida en almacén.");
    expect(result.reception).toEqual({ outcome: "nueva", courier: "tanders", label: "KP201000-S01" });
    expect(state.writes.some((w) => w.table === "order_events" && w.op === "insert")).toBe(true);
  });

  it("ya recibida: repetida con la hora de la PRIMERA recepción (no el sello del courier), sin escribir", async () => {
    state.receivedAt = ["2026-11-05T22:00:00Z", "2026-11-05T21:45:00Z"];
    const result = await receiveReturnedPackage("KP201000-S01");
    expect(result.error).toBeUndefined();
    expect(result.notice).toBe("KP201000-S01: Esta caja ya se había recibido en almacén.");
    expect(result.reception).toEqual({ outcome: "repetida", courier: "tanders", label: "KP201000-S01", firstReceivedAt: "2026-11-05T21:45:00Z" });
    expect(state.writes).toEqual([]);
  });

  it("sin sello del courier: la sella y es nueva", async () => {
    state.guide = { delivery_status: "en_ruta", custody_state: "retorno", returned_at: null };
    const result = await receiveReturnedPackage("KP201000-S01");
    expect(result.reception?.outcome).toBe("nueva");
    expect(state.writes.some((w) => w.table === "order_events" && w.op === "insert")).toBe(true);
  });

  it("dos lecturas a la vez: el sello no se escribió y la otra ya la recibió → repetida, sin segundo evento", async () => {
    state.guide = { delivery_status: "en_ruta", custody_state: "retorno", returned_at: null };
    state.sealedRows = 0;
    // La primera lectura no ve recepción; la relectura, tras perder el sello, sí.
    let reads = 0;
    Object.defineProperty(state, "receivedAt", { configurable: true, get: () => (reads++ === 0 ? [] : ["2026-11-05T21:45:00Z"]), set: () => {} });
    const result = await receiveReturnedPackage("KP201000-S01");
    Object.defineProperty(state, "receivedAt", { configurable: true, writable: true, value: [] });
    expect(result.error).toBeUndefined();
    expect(result.reception).toEqual({ outcome: "repetida", courier: "tanders", label: "KP201000-S01", firstReceivedAt: "2026-11-05T21:45:00Z" });
    expect(state.writes.some((w) => w.table === "order_events" && w.op === "insert")).toBe(false);
  });

  it("…y si nadie la recibió (el courier selló en medio), pide volver a escanear sin escribir el evento", async () => {
    state.guide = { delivery_status: "en_ruta", custody_state: "retorno", returned_at: null };
    state.sealedRows = 0;
    const result = await receiveReturnedPackage("KP201000-S01");
    expect(result.error).toBe("KP201000-S01: la guía cambió mientras escaneabas. Vuelve a escanearla.");
    expect(state.writes.some((w) => w.table === "order_events" && w.op === "insert")).toBe(false);
  });

  it("dada por entregada: error, sin resultado de recepción", async () => {
    state.guide = { delivery_status: "entregado", custody_state: "courier", returned_at: null };
    const result = await receiveReturnedPackage("KP201000-S01");
    expect(result.error).toContain("ENTREGADA");
    expect(result.reception).toBeUndefined();
  });
});
