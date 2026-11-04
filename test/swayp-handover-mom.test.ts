// «Entrega a Swayp · Lima» en el MOM (docs/mom/master-pedidos-v1.md §9.1,
// fase 3, owner 04-11-2026): las decisiones con las palabras del owner, los
// textos de la pantalla tal cual, el cambio de tipo de ruta, R9, §6.3 y la
// corrección de «pasada la medianoche».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWAYP_ALERT_NO_DESPACHO,
  SWAYP_ALERT_NO_SALIO_EN_REPARTO,
  SWAYP_CLOSE_COUNT_LABEL,
  SWAYP_CLOSE_COUNT_MISMATCH,
  SWAYP_CLOSE_DRIVER_LABEL,
  SWAYP_CLOSE_MISSING,
  SWAYP_ENTREGA_CERRADA,
  SWAYP_ENTREGA_EN_CURSO,
  SWAYP_ENTREGA_NO_VINO,
  SWAYP_ENTREGA_SIN_ABRIR,
  SWAYP_HANDOVER_BUTTON,
  SWAYP_HANDOVER_CERRADA,
  SWAYP_HANDOVER_CLOSED,
  SWAYP_HANDOVER_NO_PERMISSION,
  SWAYP_HANDOVER_OTRO_COURIER,
  SWAYP_HANDOVER_OTRO_DIA,
  SWAYP_HANDOVER_PROVINCIA,
  SWAYP_HANDOVER_SCAN_NOTE,
  SWAYP_HANDOVER_SCANNED,
  SWAYP_HANDOVER_STALE_REASON,
  SWAYP_HANDOVER_YA_ENTREGADA,
  SWAYP_HOY_FALTA_ENTREGA,
  SWAYP_MANIFEST_FROM_ALMACEN,
  SWAYP_NO_SALE_DETAIL_LABEL,
  SWAYP_NO_SALE_DETAIL_MAX,
  SWAYP_NO_SALE_DETAIL_MIN,
  SWAYP_NO_SALE_QUESTION,
  SWAYP_NO_SALE_REASONS,
  SWAYP_NO_VINO_CONFIRM,
  SWAYP_NO_VINO_REASON,
  SWAYP_ROW_ENTREGADA,
  SWAYP_ROW_SIN_ENTREGA,
  SWAYP_SCAN_USE_HANDOVER,
} from "@/lib/swayp-handover";
import { SWAYP_ASESORA_NOCHE } from "@/lib/warehouse-swayp";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

const MOM = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
function section(start: string, end: string): string {
  const from = MOM.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = MOM.indexOf(end, from + start.length);
  return flat(MOM.slice(from, to === -1 ? undefined : to));
}

const s = section("#### Entrega a Swayp · Lima (Almacén, fase 3, 04-11-2026)", "### 9.2 ");

describe("las decisiones del owner (04-11-2026), con sus palabras", () => {
  it("E1 a E4", () => {
    expect(s).toContain("«recoge a eso de las 7am de Lima. lo despacha entre yohalis, mildred o yelitza»");
    expect(s).toContain("**Un solo cotejo (E2).** «de acuerdo»");
    expect(s).toContain("«lo que sale a reparto? en teoria manda lo que se tenga cargado en Swayp porque sino de ahi van a reportar que no llegó el pedido»");
    expect(s).toContain("Kapta no cambia el estado ni la custodia que reporta Swayp");
    expect(s).toContain("«ok, pero que quede bien explicado porqué no sale»");
    expect(s).toContain("«aqui no faltaria quizás un paso de cotejo? como cuando cotejamos la caja de los motorizados en grupo gf»");
  });
});

describe("cita los textos de la pantalla tal cual (lib/swayp-handover.ts)", () => {
  it("abrir, escanear y lo que no entra", () => {
    const quotes = [
      SWAYP_HANDOVER_BUTTON("mié 4 nov"),
      SWAYP_HANDOVER_NO_PERMISSION,
      SWAYP_HANDOVER_SCANNED("KP201878-S01"),
      SWAYP_HANDOVER_SCAN_NOTE,
      SWAYP_HANDOVER_OTRO_COURIER("KP201453-S01", "Grupo GF"),
      SWAYP_HANDOVER_PROVINCIA,
      SWAYP_HANDOVER_OTRO_DIA("jueves 5 nov"),
      SWAYP_HANDOVER_CERRADA("Devolución"),
      SWAYP_HANDOVER_YA_ENTREGADA,
      SWAYP_HANDOVER_CLOSED,
      SWAYP_SCAN_USE_HANDOVER,
      SWAYP_MANIFEST_FROM_ALMACEN,
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
  });

  it("«No sale»: la lista cerrada, la pregunta, la explicación y sus límites", () => {
    for (const reason of SWAYP_NO_SALE_REASONS) expect(s, reason.label).toContain(`«${reason.label}»`);
    expect(s).toContain("«El chofer de Swayp no la llevó» (explicación obligatoria)");
    expect(s).toContain("«Otro motivo» (explicación obligatoria)");
    expect(s).toContain(`«${SWAYP_NO_SALE_QUESTION("KP…")}»`);
    expect(s).toContain(`«${SWAYP_NO_SALE_DETAIL_LABEL}»`);
    expect(SWAYP_NO_SALE_DETAIL_MIN).toBe(10);
    expect(SWAYP_NO_SALE_DETAIL_MAX).toBe(300);
    expect(s).toContain("al menos 10 letras cuando es obligatoria y 300 como máximo");
    expect(s).toContain("«No salió con Swayp: <motivo>. <explicación> Seguimiento: cambia la fecha en Swayp o anula la guía hoy.»");
  });

  it("cerrar, «Swayp no vino» y «Hoy»", () => {
    const quotes = [
      SWAYP_CLOSE_DRIVER_LABEL,
      SWAYP_CLOSE_COUNT_LABEL,
      SWAYP_CLOSE_MISSING(1),
      SWAYP_CLOSE_COUNT_MISMATCH(6, 7),
      SWAYP_NO_VINO_CONFIRM(8),
      SWAYP_ENTREGA_NO_VINO(8),
      SWAYP_ENTREGA_SIN_ABRIR,
      SWAYP_ENTREGA_EN_CURSO(5, 8),
      SWAYP_ENTREGA_CERRADA({ receivedBy: "Juan Pérez", boxes: 7, time: "07:04", noSale: 1 }),
      SWAYP_ROW_ENTREGADA("07:04", "Yelitza"),
      SWAYP_ALERT_NO_SALIO_EN_REPARTO,
      SWAYP_ALERT_NO_DESPACHO("07:04", "Juan Pérez"),
      SWAYP_ROW_SIN_ENTREGA,
    ];
    for (const quote of quotes) expect(s, quote).toContain(`«${quote}`);
    expect(s).toContain(`motivo «${SWAYP_NO_VINO_REASON}»`);
    expect(s).toContain(`«${SWAYP_HANDOVER_STALE_REASON("martes 3 nov")}»`);
    expect(s).toContain("solo con Swayp en los estados 1 a 6 (cargada y sin cerrar)");
  });

  it("la falta de hoy en «Swayp por salir»", () => {
    expect(section("### 9.1 Preparación, corte y capacidad diaria", "### 9.2 ")).toContain(`«${SWAYP_HOY_FALTA_ENTREGA}»`);
  });
});

describe("lo que cambia fuera de la subsección", () => {
  it("Swayp pasa a «Entrega al courier» en la tabla de tipos de ruta", () => {
    expect(MOM).toContain("| **Ruta de reparto** | Motorizados propios, Axel, Urpi, Tanders | Cotejo del motorizado al 100 % |");
    expect(MOM).toContain("| **Entrega al courier** | Aliclik, Shalom, Olva, Swayp | Cotejo de oficina al 100 % **+ el nombre de quien recoge** |");
  });

  it("§6.3: el «evento equivalente de recepción» no vale para Swayp Lima", () => {
    expect(section("### 6.3 ", "### 6.4 ")).toContain("Swayp Lima no: su «Asignada»/«Reparto» no prueba que tenga la caja");
  });

  it("R9: la entrega tampoco sale en la Mesa de Despacho", () => {
    expect(section("### 9.1 Preparación, corte y capacidad diaria", "### 9.2 ")).toContain(
      "Su entrega a Swayp tampoco sale en la Mesa de Despacho: se abre y se cierra en este apartado (fase 3).",
    );
  });

  it("ya no dice que Swayp toma la guía «pasada la medianoche»: la carga hacia las 05:45 y la recoge hacia las 07:00", () => {
    const s91 = section("### 9.1 Preparación, corte y capacidad diaria", "### 9.2 ");
    expect(s91).toContain("Swayp carga su ruta hacia las 05:45");
    expect(s91).toContain("hacia las 07:00 del día de despacho (owner, 04-11-2026)");
    expect(s91).not.toContain("Swayp toma la guía en su sistema pasada la medianoche");
    expect(SWAYP_ASESORA_NOCHE).toBe("Ya no hay turno de almacén hoy y Swayp la recoge mañana a las 07:00. Elige el siguiente día o avisa a Almacén.");
    expect(flat(MOM)).toContain(`«${SWAYP_ASESORA_NOCHE}»`);
    expect(flat(MOM)).not.toContain("Swayp la toma en su sistema pasada la medianoche. Elige");
  });

  it("no toca el Master: ningún estado de pedido nuevo y la versión del resolvedor no cambia por esto", () => {
    expect(s).toContain("No toca provincia ni el Master (no sube `MOM_RESOLUTION_VERSION`)");
    expect(MOM_RESOLUTION_VERSION).toMatch(/^mom-v1\.\d+$/);
    expect(readFileSync(resolve(process.cwd(), "lib/order-macro-stage.ts"), "utf8")).not.toContain("swayp-handover");
  });
});
