// «Reintentos por salir» (fase 1, entrega 1c; MOM §6.2, §9.3, §9.5): las piezas
// en el código y en el MOM. Solo lee: no toca el pendiente de armado, no
// escribe el programa de Grupo GF, no cierra casos ni llama RPC; la puerta va
// dentro del cargador; y el MOM cita lo que dice la pantalla.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOX_ACTION_LABEL,
  HANDOFF_GROUP,
  HANDOFF_LINE_CAJA_NUEVA,
  HANDOFF_LINE_DESARMAR,
  HANDOFF_LINE_GF,
  HANDOFF_LINE_OTHER,
  HANDOFF_NOTE,
  POR_ARMAR_CHIP,
  REPRO_NO_LO_QUIERE_CHIP,
  RETRY_ADDED_LATE,
  RETRY_ADDED_TODAY,
  RETRY_ADDRESS_CHANGED,
  RETRY_ANAQUEL,
  RETRY_DEFAULT_CHIP,
  RETRY_EMPTY_HOY,
  RETRY_EMPTY_MANANA,
  RETRY_ERROR,
  RETRY_FACTS_CHANGED,
  RETRY_GF_STILL_LIVE,
  RETRY_HELP,
  RETRY_HOY_HELP,
  RETRY_LABELS_MAX,
  RETRY_MANANA_HELP,
  RETRY_NIGHT_BEFORE_HOY,
  RETRY_NIGHT_BEFORE_MANANA,
  RETRY_NO_ANAQUEL_DESARMAR,
  RETRY_NO_GF_PROGRAM,
  RETRY_NO_RECEPTION_OTHER,
  RETRY_NO_RECEPTION_OWN,
  RETRY_OTHER_SALIDA_EXISTS,
  RETRY_OVERDUE,
  RETRY_TRAY,
  RETRY_TRAY_OLD,
  RETRY_UNCONFIRMED,
  handoffSalidaLine,
} from "@/lib/warehouse-retries";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
/** El MOM en una línea: sus citas se parten al ajustar el párrafo. */
const flat = (text: string) => text.replace(/\s+/g, " ");

/** El cuerpo de una función de un archivo, hasta la siguiente exportada. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + signature.length);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Los archivos propios de la entrega 1c: la estación los usa, no al revés. */
const RETRY_FILES = [
  "lib/warehouse-retries.ts",
  "lib/warehouse-retries-access.ts",
  "components/warehouse-retries.tsx",
];

describe("solo lee (§9.5, entrega 1c)", () => {
  it("los archivos de 1c existen", () => {
    for (const file of RETRY_FILES) expect(existsSync(resolve(root, file)), file).toBe(true);
  });

  it("nunca tocan el pendiente de armado, el programa de Grupo GF ni los casos", () => {
    for (const file of RETRY_FILES) {
      const src = read(file);
      for (const name of [
        "loadWarehousePending",
        "warehousePending",
        "writeGfDispatchProgram",
        "clearGfDispatchPrograms",
        "materializeWaitingAgreementsSafe",
        "closeStaleReproCases",
        "recomputeOrderMaster",
      ]) {
        expect(src, `${file}: ${name}`).not.toContain(name);
      }
      expect(src, `${file}: .rpc(`).not.toMatch(/\.rpc\(/);
      expect(src, `${file}: order_events`).not.toMatch(/\.from\("order_events"\)\s*\.(insert|update|upsert|delete)\(/);
    }
  });

  it("las lecturas no escriben, ni aplazan un cierre", () => {
    for (const file of ["lib/warehouse-retries.ts", "lib/warehouse-retries-access.ts"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      expect(src, file).not.toMatch(/\bafter\(/);
      expect(src, file).not.toContain("markShipmentReady");
      expect(src, file).not.toContain("getWarehouseStationData");
    }
    // El motor de Repro Lima, sin cerrar los casos que quedaron viejos.
    expect(read("lib/warehouse-retries-access.ts")).toContain("loadReproLima(admin, scope, now, { orderIds, closeStale: false })");
  });

  it("Despacho del día y la estación no dependen de 1c", () => {
    expect(read("lib/dispatch-access.ts")).not.toContain("warehouse-retries");
  });
});

describe("quién entra (§9.5)", () => {
  const actions = read("app/dashboard/pedidos/almacen/actions.ts");
  const access = read("lib/warehouse-retries-access.ts");

  it("la acción del servidor pasa por el cargador, que tiene la puerta", () => {
    expect(actions.startsWith('"use server";')).toBe(true);
    const load = body(actions, "export async function loadWarehouseRetries(");
    expect(load).toContain("return getWarehouseRetries();");
    expect(load).not.toContain("createAdminSupabase");
    const loader = body(access, "export async function getWarehouseRetries(");
    expect(loader).toContain("await requireWarehouse()");
    expect(loader.indexOf("await requireWarehouse()")).toBeLessThan(loader.indexOf("createAdminSupabase()"));
  });

  it("la puerta es `warehouse.prepare` y las tiendas de Equipo, no la de Repro Lima ni la de Grupo GF", () => {
    const gate = body(access, "export async function requireWarehouse(");
    expect(gate).toContain('if (!user) redirect("/login");');
    expect(gate).toContain('permissions.can("warehouse.prepare")');
    expect(gate).toContain("await getAccessibleStores()");
    // El rol «Almacén» no tiene ninguna de las dos (lib/permissions.ts).
    for (const other of ["requireReproLima(", "requireOperator(", "canOperateGroupGf(", 'can("repro_lima.manage")']) {
      expect(access, other).not.toContain(other);
    }
  });
});

describe("el MOM lo documenta (§6.2, §9.3, §9.5)", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const section = (start: string, end: string) => {
    const from = mom.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    const to = mom.indexOf(end, from + start.length);
    return flat(mom.slice(from, to === -1 ? undefined : to));
  };
  const s62 = section("### 6.2 Preparación", "### 6.3 ");
  const s93 = section("### 9.3 Resultado fallido y nueva salida", "### 9.4 ");
  const s95 = section("### 9.5 Reprogramación en Lima", "## 10. ");
  const title = "#### Almacén: «Reintentos por salir» (fase 1, entrega 1c, 13-10-2026)";
  const s1c = section(title, "**Lagunas conocidas");

  it("con sus títulos", () => {
    expect(mom).toContain("### 9.5 Reprogramación en Lima: «Repro Lima» (fase 1, entregas 1a y 1c)");
    expect(mom).toContain(title);
    expect(s95).toContain(flat(title));
    expect(s95).toContain("**Lagunas conocidas de las entregas 1a y 1c.**");
  });

  it("§6.2: un apartado aparte, que no es la cola de armado", () => {
    expect(s62).toContain("La misma pantalla tiene un apartado aparte, «Reintentos por salir» (§9.5)");
    expect(s62).toContain("no entra en los recuadros de «Por empacar» ni en el pendiente de la Mesa de despacho, no usa los cortes de turno, y lo que ya está en «Por armar» no se cuenta dos veces.");
  });

  it("§9.3: Almacén lee la acción, y sin acuerdo la de la tabla (decisión 1)", () => {
    expect(s93).toContain("en el caso con quién decidió y cuándo. Almacén la lee en «Reintentos por salir» (§9.5).");
    expect(s93).toContain(RETRY_DEFAULT_CHIP);
    expect(s93).toContain("Sin acuerdo de Repro Lima (un «Programar» de Grupo GF o una fecha del motorizado, §29.7), nadie declaró cambios");
    expect(s93).toContain("(decisión 1 del owner, 13-10-2026)");
  });

  it("§9.5: los pasos de la fase 0 y las lagunas", () => {
    expect(s95).toContain("en la bandeja del día en que se recibió (bandejas fijas: una por día de recepción y una «sin fecha / más de 7 días», plan del 11-10-2026).");
    expect(s95).toContain("Almacén lo lee en «Reintentos por salir» (abajo): qué cajas salen hoy y mañana y qué hacer con cada una.");
    expect(s95).not.toContain("(entrega 1c) llegan después");
    expect(s95).toContain("El WhatsApp con plantilla al marcar «No entregado» (entrega 1b) llega después.");
    expect(s95).toContain("Kapta no registra «en el anaquel», «reimpreso» ni «desarmada»");
    expect(s95).toContain("El reintento que Grupo GF toma sin programa no tiene fecha para Almacén.");
    expect(s95).toContain("Una salida de Tanders creada sin «por definir» puede nacer `no_iniciado` y no entra en «Por armar».");
  });

  it("las dos decisiones del owner del 13-10-2026", () => {
    expect(s1c).toContain("Decisiones del owner sobre el diseño de la entrega 1c (13-10-2026):");
    expect(s1c).toContain("muestra la acción por defecto que Kapta calcula con los hechos y sin cambios declarados (§9.3)");
    expect(s1c).toContain("El cuaderno «DESARMAR» sigue siendo el registro de lo que se desarma. La lista solo marca en rojo la caja de «no lo quiere» que Grupo GF volvió a programar.");
    expect(s1c).toContain("No es el estado «DESARMAR» de Liquidaciones 2.");
  });

  it("cita los textos de la pantalla tal cual (lib/warehouse-retries.ts)", () => {
    const quotes = [
      RETRY_HELP,
      RETRY_HOY_HELP("12:00"),
      RETRY_MANANA_HELP,
      RETRY_DEFAULT_CHIP,
      RETRY_UNCONFIRMED,
      RETRY_FACTS_CHANGED,
      RETRY_NO_ANAQUEL_DESARMAR,
      RETRY_NO_GF_PROGRAM,
      RETRY_OVERDUE("lun 12/10"),
      RETRY_ADDED_TODAY("09:40"),
      RETRY_ADDED_LATE("12:40"),
      RETRY_NIGHT_BEFORE_MANANA,
      RETRY_NIGHT_BEFORE_HOY,
      RETRY_NO_RECEPTION_OWN,
      RETRY_NO_RECEPTION_OTHER("Tanders"),
      RETRY_ADDRESS_CHANGED("12/10"),
      RETRY_ANAQUEL("jue 15/10"),
      RETRY_TRAY("lun 12/10"),
      RETRY_TRAY_OLD,
      RETRY_OTHER_SALIDA_EXISTS("Tanders"),
      RETRY_GF_STILL_LIVE,
      HANDOFF_GROUP,
      HANDOFF_NOTE,
      HANDOFF_LINE_GF,
      HANDOFF_LINE_OTHER("Tanders"),
      HANDOFF_LINE_DESARMAR,
      HANDOFF_LINE_CAJA_NUEVA,
      POR_ARMAR_CHIP(BOX_ACTION_LABEL.salida_nueva_rearmar),
      RETRY_ERROR,
      RETRY_EMPTY_HOY,
      RETRY_EMPTY_MANANA,
      REPRO_NO_LO_QUIERE_CHIP,
      handoffSalidaLine({ code: "KP1-S03", armed: false, readyAt: null })!,
      handoffSalidaLine({ code: "KP1-S03", armed: true, readyAt: "2026-10-13T15:12:00.000Z" })!,
    ];
    for (const quote of quotes) expect(s1c, quote).toContain(`«${quote}`);
    // Los ejemplos que el MOM escribe con esos textos.
    expect(s1c).toContain("«Reintento · Salida nueva y rearmado»");
    expect(s1c).toContain("«Falta armarla · KP1-S03» o «Armada 10:12 · KP1-S03»");
  });

  it("y las cifras que cita son las del código", () => {
    const access = read("lib/warehouse-retries-access.ts");
    const pure = read("lib/warehouse-retries.ts");
    expect(s1c).toContain("Se leen hasta 300 pedidos, primero los de día más antiguo.");
    expect(access).toContain("export const RETRY_CANDIDATES_MAX = 300;");
    expect(s1c).toContain("si el caso sigue abierto o se cerró por dejar la etapa en los últimos 14 días");
    expect(access).toContain("const HANDOFF_DAYS = 14;");
    expect(access).toContain('.eq("close_reason", "fuera_de_etapa")');
    // Los abiertos también: Almacén no cierra casos (`closeStale: false`).
    expect(s1c).toContain("El caso sigue abierto hasta que alguien abre Repro Lima, que es quien lo cierra: Almacén lee sin cerrar casos.");
    expect(access).toContain('byStores<ReproCaseRow>((chunk) => handoffAgreements(chunk)\n      .is("closed_at", null)');
    // El día de «Ya en «Por armar»»: el programa vigente, leído sin filtro de fecha.
    expect(s1c).toContain("Su día es el del programa vigente de Grupo GF, sea cual sea su fecha; sin programa, el acordado. Si Grupo GF lo movió a después de mañana, no se lista.");
    const handoffs = access.slice(access.indexOf("async function loadHandoffs("));
    const live = handoffs.slice(handoffs.indexOf('.from("gf_dispatch_programs")'), handoffs.indexOf("]);"));
    expect(live).toContain('.in("store_id", storeIds)');
    expect(live).not.toMatch(/\.(lte|gte|lt|gt|eq)\("scheduled_for"/);
    // La caja que la recepción misma programó va al anaquel: hasta 2 minutos.
    expect(s1c).toContain("el programa es de Repro Lima y se escribió hasta 2 minutos después de la recepción");
    expect(s1c).toContain("Un programa escrito más tarde (una confirmación posterior, «Programar ahora») no cuenta");
    expect(pure).toContain("export const RECEPTION_PROGRAM_WINDOW_MS = 2 * 60_000;");
    expect(s1c).toContain("la del día en que se recibió, hasta 7 días");
    expect(pure).toContain("const TRAY_DAYS = 7;");
    expect(s1c).toContain("«Imprimir los 3 rótulos» los imprime juntos (hasta 200)");
    expect(RETRY_LABELS_MAX).toBe(200);
    expect(s1c).toContain("(`closeStale: false`)");
    expect(s1c).toContain("`MOM_RESOLUTION_VERSION` sigue en `mom-v1.26`");
    expect(read("lib/order-macro-stage.ts")).toContain('export const MOM_RESOLUTION_VERSION = "mom-v1.26" as const;');
  });

  it("y lo que hace la pantalla", () => {
    const ui = read("components/warehouse-retries.tsx");
    // «Prepárala hoy» primero en «Mañana», con su tanda de rótulos.
    expect(s1c).toContain("En «Mañana», antes que todos, «Prepárala hoy»");
    expect(ui).toContain('"Prepárala hoy"');
    expect(ui).toContain("Imprimir los ${");
    // Se relee al volver a la pestaña tras 5 minutos; nunca tras cada escaneo.
    expect(s1c).toContain("al volver a la pestaña si pasaron 5 minutos o cambió el día. Nunca después de cada escaneo de armado.");
    expect(ui).toContain("5 * 60_000");
  });

  it("el segundo aviso del escáner solo sale si el escaneo de esa caja sale bien", () => {
    expect(s1c).toContain("Si el escaneo de esa caja sale bien en Almacén (queda lista para despacho o ya lo estaba) y es de un reintento listado");
    expect(s1c).toContain("Si el escaneo la rechaza, no hay segundo aviso, aunque la caja sea de un reintento listado.");
    expect(s1c).toContain("Le pasa a la caja devuelta de otro courier (Tanders, Swayp): ya no está en custodia de la empresa y el escáner de Almacén no la arma.");
    // La pista busca `result.shipment`, y `markShipmentReady` solo la devuelve
    // cuando la caja queda lista o ya lo estaba: ningún rechazo trae la salida.
    expect(read("components/warehouse-station.tsx")).toContain("setRetryHint(retryScanHint(retries, result.shipment?.order_id));");
    const scan = body(read("app/dashboard/pedidos/despacho/actions.ts"), "export async function markShipmentReady(");
    const returns = scan.match(/return \{[^;]*\};/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const ret of returns) {
      if (ret.startsWith("return { error")) expect(ret, ret).not.toContain("shipment }");
      else expect(ret, ret).toMatch(/^return \{ notice: .*, shipment \};$/);
    }
    // La caja que ya no está en custodia de la empresa (la de otro courier que volvió) se rechaza.
    expect(scan).toMatch(/if \(shipment\.custody_state !== "empresa"\) \{[\s\S]*?return \{ error:/);
  });

  it("dice dónde vive (Implementación y Pruebas)", () => {
    for (const file of [
      "lib/warehouse-retries.ts",
      "lib/warehouse-retries-access.ts",
      "app/dashboard/pedidos/almacen/actions.ts",
      "app/dashboard/pedidos/almacen/page.tsx",
      "components/warehouse-retries.tsx",
      "components/warehouse-station.tsx",
      "test/warehouse-retries.test.ts",
      "test/warehouse-retries-access.test.ts",
      "test/warehouse-retries-ui.test.ts",
      "test/warehouse-retries-source.test.ts",
    ]) {
      expect(s95, file).toContain(`\`${file}\``);
      expect(existsSync(resolve(root, file)), file).toBe(true);
    }
  });
});

describe("DESIGN.md y DEPLOY.md", () => {
  it("el apartado en el alcance del diseño de operación", () => {
    expect(flat(read("DESIGN.md"))).toContain("y «Armados hoy», y desde el 13-10-2026, debajo de la estación, «Reintentos por salir»: una tarjeta aparte con «Hoy» y «Mañana» en dos zonas");
  });

  it("sin migración", () => {
    const deploy = flat(read("DEPLOY.md"));
    expect(deploy).toContain("### 13-10-2026 · Repro Lima, entrega 1c: «Reintentos por salir» en Almacén");
    expect(deploy).toContain("Entrega 1c: sin migración.");
  });
});
