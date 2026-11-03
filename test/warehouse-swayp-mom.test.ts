// «Swayp por salir · Lima» (Almacén, fase 1, solo lectura; owner 03-11-2026):
// que lo que el MOM cita —las decisiones D1 a D5, las horas, los textos de la
// pantalla, del escáner y de la asesora— sea lo que dicen las constantes de
// lib/warehouse-swayp.ts, y que la corrección de D1 («en Lima la caja la arma
// nuestro almacén») quede escrita en §6.2, §9, §9.1, §11 y §11.6.1. Las reglas
// se prueban en test/warehouse-swayp.test.ts; la puerta de la asesora, en
// test/swayp-asesora-lote.test.ts.

import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  swaypCell,
  swaypDayLabel,
  swaypShortDayLabel,
  swaypZoneHeadline,
  swaypZoneTitle,
  SWAYP_ARMED_CHIP,
  SWAYP_ASESORA_CREATED,
  SWAYP_ASESORA_NOCHE,
  SWAYP_ASESORA_TARDE,
  SWAYP_AUTO_REFRESH_FROM_MINUTE,
  SWAYP_AUTO_REFRESH_MS,
  SWAYP_AUTO_REFRESH_UNTIL_MINUTE,
  SWAYP_CANCELLED_STATES,
  SWAYP_CLOSED_AFTER_PICKUP_STATES,
  SWAYP_CELL_COMPLETE,
  SWAYP_CELL_ERROR,
  SWAYP_CELL_TITLE,
  SWAYP_CHIP_ARMADA_POR_DEFINIR,
  SWAYP_CHIP_ERA_POR_DEFINIR,
  SWAYP_CHIP_LATE,
  SWAYP_CHIP_SALIDA_NUEVA,
  SWAYP_CHIP_SIN_ARMAR,
  SWAYP_CREATED_LINE,
  SWAYP_CREATOR_AUTOMATIC,
  SWAYP_CREATOR_UNKNOWN,
  SWAYP_EMPTY,
  SWAYP_ERROR,
  SWAYP_FIGURE_LABEL,
  SWAYP_GUIDE_LINE,
  SWAYP_HELP,
  SWAYP_HOY_FALTA_AQUI,
  SWAYP_HOY_FALTA_TOMADA,
  SWAYP_HOY_NOTE,
  SWAYP_HOY_STATE_LINE,
  SWAYP_HOY_URGENT,
  SWAYP_LIMA_PANEL_ZERO,
  SWAYP_NIGHT_CUTOFF_LABEL,
  SWAYP_NOT_TAKEN_MAX_STATE,
  SWAYP_PROVINCIA,
  SWAYP_READ_AT,
  SWAYP_REFRESH,
  SWAYP_REFRESH_ERROR,
  SWAYP_RETRY,
  SWAYP_REVISAR_HELP,
  SWAYP_REVISAR_LINE,
  SWAYP_ROUTE_CLOSE_LABEL,
  SWAYP_SALIO_ANULADA,
  SWAYP_SALIO_ARMADA,
  SWAYP_SALIO_CANCELADA,
  SWAYP_SALIO_FECHA,
  SWAYP_SALIO_PEDIDO_ANULADO,
  SWAYP_SCAN_ANULADA,
  SWAYP_SCAN_CANCELADA,
  SWAYP_SCAN_COMPLETO,
  SWAYP_SCAN_FALTAN,
  SWAYP_SCAN_FECHA,
  SWAYP_SCAN_FUERA,
  SWAYP_SCAN_LIST_MAX,
  SWAYP_SCAN_ROTULO_VIEJO,
  SWAYP_TITLE,
  SWAYP_TONE_ANTES_VISPERA,
  SWAYP_TONE_CERRO,
  SWAYP_TONE_COMPLETO,
  SWAYP_TONE_CORTE,
  SWAYP_TONE_TOMADAS,
  SWAYP_TONE_VISPERA,
  SWAYP_WHERE_HERMANA_ARMADA,
  SWAYP_WHERE_HERMANA_FUERA,
  SWAYP_WHERE_HERMANA_VOLVIO,
  SWAYP_WHERE_POR_DEFINIR,
  SWAYP_WHERE_STOCK,
} from "@/lib/warehouse-swayp";
import { SWAYP_STATES } from "@/lib/swayp-states";
import { WAREHOUSE_SHIFTS, formatMinutes } from "@/lib/warehouse-shift";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
/** El MOM en una línea: sus citas se parten al ajustar el párrafo. */
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");

/** Desde `start` hasta `end` (o el final), en una línea. */
function section(start: string, end: string): string {
  const from = MOM.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = MOM.indexOf(end, from + start.length);
  return flat(MOM.slice(from, to === -1 ? undefined : to));
}

const TITLE = "#### Swayp por salir · Lima (Almacén, fase 1, 03-11-2026)";
const WED = "2026-11-04";
const wed = swaypDayLabel(WED);

describe("dónde está escrito", () => {
  const s91 = section("### 9.1 Preparación, corte y capacidad diaria", "### 9.2 ");

  it("una subsección de §9.1, junto a la hora de decisión de Swayp", () => {
    expect(MOM.split(TITLE)).toHaveLength(2);
    expect(s91).toContain(flat(TITLE));
    // La fila de Swayp de la tabla sigue diciendo cuándo Swayp cierra su ruta.
    expect(s91).toContain("| Swayp | De 16:00 a 17:00 del día anterior, de lunes a sábado | Al día siguiente; nunca el mismo día ni en domingo (§11.6.1) |");
    expect(s91).toContain("**Swayp en Lima: quién arma y hasta cuándo (03-11-2026, decisiones del owner).**");
  });

  it("§6.2 lo nombra como apartado aparte de la estación, que no es la cola de armado", () => {
    const s62 = section("### 6.2 Preparación", "### 6.3 ");
    expect(s62).toContain("Desde el 03-11-2026 tiene otro apartado aparte, «Swayp por salir · Lima» (§9.1)");
    expect(s62).toContain(
      "**En Lima y Callao la caja de Swayp la arma este almacén y Swayp la recoge en la oficina; la de provincia la arma la bodega regional de Swayp** (decisión del owner, 03-11-2026).",
    );
    expect(s62).toContain("no suma en «Por armar», ni en el número de Lima de «Por empacar», ni en «Entregas a couriers».");
    expect(s62).toContain(`En «Por empacar» lleva su propia celda, «${SWAYP_CELL_TITLE}», que no se suma a la de Lima.`);
  });

  it("§9 (Lima) dice quién arma la caja de Swayp", () => {
    const s9 = section("## 9. Lima", "### 9.1 ");
    expect(s9).toContain("**También las guías Swayp de Lima y Callao (decisión del owner, 03-11-2026):** la caja la arma nuestro almacén en la oficina y Swayp la recoge ahí.");
  });

  it("§11.6.1 lleva el aviso a la asesora y remite a §9.1", () => {
    const s1161 = section("#### 11.6.1 Swayp despacha de lunes a sábado (10-10-2026)", "### 11.7 ");
    expect(s1161).toContain("**Con destino de Lima, la fecha es el lote del almacén (03-11-2026, decisiones del owner D1 y D3).**");
    expect(s1161).toContain("(§9.1, «Swayp por salir · Lima»)");
  });
});

describe("las decisiones del owner (03-11-2026)", () => {
  const s = section(TITLE, "### 9.2 ");

  it("D1 a D5, tal cual", () => {
    expect(s).toContain("**Decisiones del owner (03-11-2026), aprobadas tal cual:**");
    expect(s).toContain("Las guías Swayp de Lima y Callao las arma nuestro almacén y Swayp las recoge en la oficina; las de provincia las arma la bodega regional de Swayp («En Lima los arma nuestro almacén, provincia los arma Swayp»).");
    expect(s).toContain("**El límite práctico (D2)** es el corte del turno noche de la víspera, a las 21:20");
    expect(s).toContain("**Lo que llega tarde (D3). Nada bloquea.**");
    expect(s).toContain("la caja lleva el rótulo de la S02, la S02 cuenta como falta hasta que se escanee y Despacho retira la S01.");
    expect(s).toContain("El lote del lunes lo arma el turno noche del domingo (el sábado no hay turno noche).");
  });

  it("las horas que cita son las del código", () => {
    const noche = WAREHOUSE_SHIFTS.find((shift) => shift.id === "noche")!;
    expect(SWAYP_NIGHT_CUTOFF_LABEL).toBe(noche.cutoff);
    expect(SWAYP_NIGHT_CUTOFF_LABEL).toBe("21:20");
    expect(SWAYP_ROUTE_CLOSE_LABEL).toBe("17:00");
    expect(s).toContain("las 17:00 (Swayp cierra su ruta; desde ahí lo nuevo es «agregado tarde») y las 21:20 (el corte del turno noche, el límite real)");
    // La relectura sola: cada 5 minutos, de 16:00 a 21:30.
    expect(SWAYP_AUTO_REFRESH_MS).toBe(5 * 60_000);
    expect(SWAYP_AUTO_REFRESH_FROM_MINUTE).toBe(16 * 60);
    expect(SWAYP_AUTO_REFRESH_UNTIL_MINUTE).toBe(21 * 60 + 30);
    expect(s).toContain("cada 5 minutos entre las 16:00 y las 21:30 de Lima");
    // Cancelada es el 10, el único de cancelación del mapa de Swayp.
    expect([...SWAYP_CANCELLED_STATES]).toEqual([10]);
    expect(SWAYP_STATES[10]).toBe("Cancelada");
    expect(s).toContain("ni canceladas por Swayp (estado 10, el único de cancelación del mapa de `lib/swayp-states.ts`)");
    // «Hoy»: Swayp aún no la tomó con estado 1 o 2.
    expect(SWAYP_NOT_TAKEN_MAX_STATE).toBe(2);
    expect(s).toContain(`(sin estado, 1 «${SWAYP_STATES[1]}» o 2 «${SWAYP_STATES[2]}»)`);
    // Hasta 3 códigos en el aviso del escáner.
    expect(SWAYP_SCAN_LIST_MAX).toBe(3);
    expect(s).toContain("hasta 3 códigos y «y N más»");
    // «Era «por definir»»: nacida más de 2 minutos antes que la guía.
    expect(read("lib/warehouse-swayp.ts")).toContain("const PRE_EXISTING_MARGIN_MS = 2 * MINUTE_MS;");
    expect(s).toContain("nacida más de 2 minutos antes de la guía");
  });

  it("solo lee: sin migración y sin cambiar la versión del resolvedor", () => {
    expect(s).toContain("No escribe en la base, no hay migración ni kinds nuevos y no cambia el Master: `MOM_RESOLUTION_VERSION` sigue en `mom-v1.36`.");
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.36");
    expect(s).toContain("Nunca hay «marcar armada» a mano: armada es el escaneo.");
    expect(s).toContain("Llega por GET (`/api/almacen/swayp`, sin caché)");
    expect(read("app/api/almacen/swayp/route.ts")).toContain('{ headers: { "Cache-Control": "no-store" } }');
  });

  it("el día es la fecha UTC y quién arma lo dice `macro_operation`", () => {
    expect(s).toContain("El día de despacho es la FECHA UTC de `next_followup_at`");
    expect(s).toContain("Nunca se convierte a hora de Lima: caería un día antes.");
    expect(s).toContain("se reparten por `order_master.macro_operation`, nunca por `shipments.city` (hay hijas de provincia con `city` nulo)");
    expect(read("lib/warehouse-swayp-access.ts")).toContain("macro_operation");
  });

  it("las fases siguientes quedan pendientes", () => {
    expect(s).toContain("**Fases siguientes, pendientes del owner.** Fase 2: cerrar una falta con motivo. Fase 3: la entrega cotejada a Swayp (hoy Kapta no la registra). Fase 4: «Salida Swayp programada» en el Master.");
    expect(s).toContain("**Lagunas conocidas de la fase 1.**");
  });
});

describe("cita los textos de la pantalla tal cual (lib/warehouse-swayp.ts)", () => {
  const s = section(TITLE, "### 9.2 ");

  it("el apartado, sus zonas y sus cifras", () => {
    const quotes = [
      SWAYP_TITLE,
      SWAYP_HELP,
      SWAYP_READ_AT("17:42"),
      SWAYP_REFRESH,
      SWAYP_ERROR,
      SWAYP_RETRY,
      SWAYP_EMPTY(wed),
      swaypZoneTitle("hoy", "2026-11-03", "2026-11-03"),
      swaypZoneTitle("proximo", WED, "2026-11-03"),
      swaypZoneTitle("proximo", "2026-11-09", "2026-11-07"),
      swaypZoneHeadline("proximo", WED, { programadas: 9, armadas: 8, faltan: 1 }),
      swaypZoneHeadline("hoy", "2026-11-03", { programadas: 7, armadas: 7, faltan: 0 }),
      SWAYP_FIGURE_LABEL.programadas,
      SWAYP_FIGURE_LABEL.armadas,
      SWAYP_FIGURE_LABEL.faltan,
      SWAYP_FIGURE_LABEL.agregadasTarde,
    ];
    for (const quote of quotes) expect(s, quote).toContain(quote);
    expect(swaypZoneTitle("proximo", "2026-11-09", "2026-11-07")).toBe("Próximo despacho · lunes 9 nov");
    // El plural y el lote completo.
    expect(swaypZoneHeadline("proximo", WED, { programadas: 9, armadas: 7, faltan: 2 })).toMatch(/· faltan 2$/);
    expect(swaypZoneHeadline("proximo", WED, { programadas: 9, armadas: 9, faltan: 0 })).toMatch(/· lote completo$/);
    expect(s).toContain("(«faltan 2»; sin faltas, «… · lote completo»)");
  });

  it("las filas: chapas, quién creó la guía y dónde está la caja", () => {
    const quotes = [
      SWAYP_CHIP_SIN_ARMAR,
      SWAYP_CHIP_SALIDA_NUEVA,
      SWAYP_CHIP_ERA_POR_DEFINIR,
      SWAYP_CHIP_ARMADA_POR_DEFINIR,
      SWAYP_CHIP_LATE("20:43"),
      SWAYP_GUIDE_LINE("KP143987-S02", "50000165022"),
      SWAYP_CREATED_LINE("<nombre>", "martes 3 nov 00:11"),
      SWAYP_CREATED_LINE(SWAYP_CREATOR_UNKNOWN, "martes 3 nov 00:11"),
      SWAYP_CREATOR_AUTOMATIC,
      SWAYP_WHERE_POR_DEFINIR("KP201878-S01"),
      SWAYP_WHERE_HERMANA_ARMADA("KP1-S01", "Grupo GF", "KP1-S02", "S01"),
      SWAYP_WHERE_HERMANA_VOLVIO("KP143987-S01", "Aliclik", "KP143987-S02"),
      SWAYP_WHERE_HERMANA_FUERA("KP142666-S01", "Grupo GF", "KP142666-S02"),
      SWAYP_WHERE_STOCK("KP1-S02"),
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
  });

  it("salieron de la lista, revisar y provincia", () => {
    const quotes = [
      SWAYP_SALIO_CANCELADA,
      SWAYP_SALIO_ANULADA,
      SWAYP_SALIO_PEDIDO_ANULADO,
      SWAYP_SALIO_FECHA("viernes 6 nov"),
      SWAYP_SALIO_ARMADA,
      SWAYP_REVISAR_HELP,
      SWAYP_REVISAR_LINE("Agencia"),
      SWAYP_PROVINCIA(9, wed, "Arequipa 2, Ica 2"),
      SWAYP_PROVINCIA(1, wed, "Arequipa 1"),
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
    // La hora del cambio, cuando se sabe.
    expect(SWAYP_SALIO_FECHA("viernes 6 nov", "martes 3 nov 18:02")).toBe(`${SWAYP_SALIO_FECHA("viernes 6 nov")} (cambió el martes 3 nov 18:02)`);
    expect(s).toContain("(con «(cambió el martes 3 nov 18:02)» si se sabe");
  });

  it("el tono de «Próximo», siempre con su frase", () => {
    const quotes = [
      SWAYP_TONE_COMPLETO,
      SWAYP_TONE_ANTES_VISPERA(swaypDayLabel("2026-11-08")),
      SWAYP_TONE_VISPERA,
      SWAYP_TONE_CORTE(formatMinutes(70)),
      SWAYP_TONE_CERRO(1),
      SWAYP_TONE_TOMADAS(1),
      SWAYP_TONE_TOMADAS(2),
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}»`);
    expect(formatMinutes(70)).toBe("1 h 10 min");
  });

  it("«Hoy», la celda y el escáner", () => {
    const quotes = [
      SWAYP_HOY_NOTE,
      SWAYP_HOY_STATE_LINE(SWAYP_STATES[1]!, "00:38"),
      SWAYP_HOY_FALTA_AQUI,
      SWAYP_HOY_FALTA_TOMADA,
      SWAYP_CELL_TITLE,
      SWAYP_CELL_COMPLETE,
      SWAYP_CELL_ERROR,
      swaypCell({ dayLabel: wed, counts: { programadas: 9, armadas: 8, faltan: 1, agregadasTarde: 0 }, tone: null }).big,
      swaypCell({ dayLabel: wed, counts: { programadas: 9, armadas: 8, faltan: 1, agregadasTarde: 0 }, tone: null }).sub,
      SWAYP_SCAN_FALTAN(wed, 8, 9, "falta KP143987-S02 (San Bartolo)"),
      SWAYP_SCAN_COMPLETO(wed, 9),
      SWAYP_SCAN_ROTULO_VIEJO("KP1-S01", "Grupo GF", "KP1-S02"),
      SWAYP_SCAN_CANCELADA,
      SWAYP_SCAN_ANULADA,
      SWAYP_SCAN_FECHA("viernes 6 nov"),
      SWAYP_SCAN_FUERA(wed, true),
      SWAYP_ARMED_CHIP(swaypShortDayLabel(WED)),
      SWAYP_HOY_URGENT(1),
      SWAYP_LIMA_PANEL_ZERO,
      SWAYP_REFRESH_ERROR,
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
    expect(s).toContain("Cifra grande «Falta 1», «Faltan 2», «Completo» o «0»");
  });

  it("y lo que se le dice a la asesora, en §9.1 y en §11.6.1", () => {
    const s1161 = section("#### 11.6.1 Swayp despacha de lunes a sábado (10-10-2026)", "### 11.7 ");
    for (const text of [s, s1161]) {
      expect(text).toContain(`«${SWAYP_ASESORA_CREATED(wed)}»`);
      expect(text).toContain(`«${SWAYP_ASESORA_TARDE}»`);
      expect(text).toContain(`«${SWAYP_ASESORA_NOCHE}»`);
    }
    // El subtítulo de la puerta con destino de Lima, el mismo del modal.
    const modal = read("components/direct-fenix-guide-modal.tsx");
    const subtitle = /const SUBTITULO_LIMA =\s*"([^"]+)";/.exec(modal)?.[1];
    expect(subtitle).toBeTruthy();
    expect(s).toContain(`«${subtitle}»`);
    expect(s1161).toContain("Nada bloquea: la fecha sigue siendo válida y el botón no cambia. Provincia no cambia");
  });
});

describe("D1 corrige lo que el MOM decía de «la bodega de Lima de Swayp» (§11)", () => {
  it("la caja de Lima y Callao no sale de una bodega de Swayp", () => {
    const s11 = section("## 11. Reproprovincia y Swayp", "## 12. ");
    expect(s11).toContain("**En Lima y Callao la caja no sale de una bodega de Swayp (decisión del owner, 03-11-2026).** La arma nuestro almacén en la oficina y Swayp la recoge ahí; solo provincia sale armada de una bodega regional de Swayp.");
    expect(s11).toContain("**El Callao es destino propio pero se emite con el remitente de Lima**");
    // Las frases viejas solo quedan citadas, como lo que se corrigió.
    expect(s11).not.toContain("cuando la bodega de Lima de Swayp pasó a despachar pedidos");
    expect(s11).not.toContain("**El Callao es destino propio pero se despacha desde la bodega de Lima**");
    expect(s11).not.toContain("unidades** ahí: la bodega de Lima repone sola");
    expect(s11).toContain("el owner precisó el 03-11-2026 que la caja de Lima y Callao la arma nuestro almacén y Swayp la recoge en la oficina (§9.1, D1).");
    // Solo D1: el razonamiento sobre el stock no lo dio el owner.
    expect(s11).not.toContain("con nuestro stock");
    expect(s11).not.toContain("un saldo de Swayp en Lima no mediría nada");
    expect(s11).toContain("En Lima el remitente no es donde se arma la caja: la arma nuestro almacén y Swayp la recoge en la oficina (decisión del owner, 03-11-2026, §9.1).");
  });
});

// Los textos de la pantalla viven en el componente («use client»): se cargan
// como en test/warehouse-swayp-ui.test.ts.
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/pedidos/almacen", useSearchParams: () => new URLSearchParams() }));
const screen = await import("@/components/warehouse-swayp");

describe("cita los textos de la pantalla de components/warehouse-swayp.tsx y lo que la revisión del 03-11 cambió", () => {
  const s = section(TITLE, "### 9.2 ");

  it("las listas, la carga, los filtros vacíos, la relectura que falla y los botones", () => {
    const quotes = [
      screen.SWAYP_LIST_LABEL.faltan,
      screen.SWAYP_LIST_LABEL.armadas,
      screen.SWAYP_LIST_LABEL.salieron,
      screen.SWAYP_SALIERON_HELP,
      screen.SWAYP_LOADING,
      screen.SWAYP_FILTER_EMPTY.faltan,
      screen.SWAYP_FILTER_EMPTY.armadas,
      screen.SWAYP_FILTER_EMPTY.agregadasTarde,
      screen.SWAYP_STALE("17:42"),
      screen.SWAYP_LINK_STALE,
      screen.SWAYP_PRINT_LABEL,
      screen.SWAYP_OPEN_ORDER,
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
    // El domingo, el aviso «fuera de lote» sin «Hoy».
    expect(SWAYP_SCAN_FUERA("lunes 9 nov", false).startsWith("Esta caja Swayp no sale el lunes 9 nov:")).toBe(true);
    expect(s).toContain("«Esta caja Swayp no sale el lunes 9 nov: …»");
  });

  it("los tiempos de la relectura que el MOM cuenta son los del código", () => {
    expect(screen.SWAYP_WAKE_STALE_MS).toBe(60_000);
    expect(s).toContain("Al volver a la pestaña se relee si lo leído tiene un minuto o más.");
    expect(s).toContain("Si cambió el día de Lima, se relee a cualquier hora");
    expect(s).toContain("un escaneo no reinicia la cuenta");
    expect(s).toContain("Tocar la cifra elegida vuelve a «Programadas».");
  });

  it("las devoluciones de Swayp, la falta que Swayp ya tomó y la directa anulada en Kapta", () => {
    expect([...SWAYP_CLOSED_AFTER_PICKUP_STATES].sort()).toEqual([11, 12, 9].sort());
    expect(s).toContain("`SWAYP_CLOSED_AFTER_PICKUP_STATES`");
    expect(s).toContain("**La falta que Swayp ya tomó.**");
    expect(s).toContain("Se encuentra por su emisión (el día del `source_key`) y sale como «Guía anulada en Kapta»");
    // Lo que la revisión propuso y el owner tiene que confirmar, marcado como tal.
    expect(s.match(/pendientes? de que el owner los? confirme/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("la diferencia con el Excel de programación, escrita", () => {
    expect(s).toContain("así que las programadas coinciden con ese Excel filtrado a Lima, salvo en dos cosas:");
  });
});
