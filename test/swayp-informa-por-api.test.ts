// «Registrar resultado del courier» en guías que Swayp informa por API
// (MOM §11.4, 08-10-2026). El recuadro nació en julio, cuando Fénix no le
// decía nada a Kapta. Desde el 29-09 el barrido lee cada guía con número de
// Swayp cada media hora, y en #KP135202 el recuadro pedía «Obligatorio» un
// resultado que Swayp ya había dado —Devolución (8)—, sin ofrecer esa opción.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COURIER_REPORT_RESULTS,
  reconcileDeliveryStatus,
  SWAYP_API_MANUAL_EXCLUDED,
  swaypInformsByApi,
  swaypLiveSubState,
  swaypReadingSummary,
} from "@/lib/shipments";
import { SWAYP_STATES } from "@/lib/swayp";

describe("swaypInformsByApi", () => {
  const api = { courier: "fenix", swayp_guide: "50000137273", swayp_synced_at: "2026-10-08T14:52:55Z" };

  it("con número de Swayp y al menos una lectura del barrido", () => {
    expect(swaypInformsByApi(api)).toBe(true);
  });

  it("una guía manual, o nunca leída, sigue pidiendo el resultado a mano", () => {
    expect(swaypInformsByApi({ ...api, swayp_guide: null })).toBe(false);
    expect(swaypInformsByApi({ ...api, swayp_synced_at: null })).toBe(false);
    expect(swaypInformsByApi({ ...api, swayp_synced_at: undefined })).toBe(false);
  });

  it("solo Swayp", () => {
    expect(swaypInformsByApi({ ...api, courier: "aliclik" })).toBe(false);
  });
});

describe("«No contesta» no se registra a mano en una guía informada por API", () => {
  it("porque la siguiente lectura la devolvería a En ruta", () => {
    // Swayp sigue diciendo reparto o novedad (`en_ruta`): gana sobre Pendiente.
    expect(reconcileDeliveryStatus("pendiente", "en_ruta")).toBe("en_ruta");
    expect([...SWAYP_API_MANUAL_EXCLUDED]).toEqual(["no_contesta"]);
  });

  it("las correcciones que el barrido respeta siguen disponibles", () => {
    const quedan = COURIER_REPORT_RESULTS.filter((r) => !SWAYP_API_MANUAL_EXCLUDED.has(r.code)).map((r) => r.code);
    expect(quedan).toEqual(expect.arrayContaining(["entregado", "cancelado"]));
    expect(quedan).not.toContain("no_contesta");
  });
});

describe("swaypLiveSubState: lo que `en_ruta` no dice en la lista", () => {
  const viva = (swayp_state: number | null, extra: Record<string, unknown> = {}) => ({
    courier: "fenix",
    delivery_status: "en_ruta",
    swayp_state,
    ...extra,
  });

  it("en devolución y con novedad", () => {
    expect(swaypLiveSubState(viva(8))).toBe("en devolución");
    expect(swaypLiveSubState(viva(6))).toBe("con novedad");
  });

  it("en reparto, sin estado, otro courier o ya cerrada: nada que añadir", () => {
    expect(swaypLiveSubState(viva(5))).toBeNull();
    expect(swaypLiveSubState(viva(null))).toBeNull();
    expect(swaypLiveSubState(viva(8, { courier: "aliclik" }))).toBeNull();
    expect(swaypLiveSubState(viva(8, { delivery_status: "anulado" }))).toBeNull();
  });
});

describe("swaypReadingSummary", () => {
  it("dice el estado con el nombre que le da Swayp", () => {
    expect(swaypReadingSummary(8, { canResend: false }).estado).toBe(`${SWAYP_STATES[8]} (8)`);
    expect(swaypReadingSummary(99, { canResend: false }).estado).toBe("Sin estado reconocido");
    expect(swaypReadingSummary(null, { canResend: false }).estado).toBe("Sin estado reconocido");
  });

  it("#KP135202: en devolución y en provincia, ofrece el reenvío", () => {
    const r = swaypReadingSummary(8, { canResend: true });
    expect(r.detalle).toBe("Swayp no entregó y el paquete vuelve a su bodega.");
    expect(r.siguiente).toContain("«Reenviar por Swayp»");
    expect(r.siguiente).toContain("resuelve la novedad");
  });

  it("en devolución sin reenvío posible (Lima), solo revertirla", () => {
    expect(swaypReadingSummary(8, { canResend: false }).siguiente).not.toContain("Reenviar");
  });

  it("con novedad, resolverla; en bodega o en reparto, nada que registrar", () => {
    expect(swaypReadingSummary(6, { canResend: false }).siguiente).toContain("resuelve la novedad");
    for (const state of [1, 2, 3, 4, 5]) {
      expect(swaypReadingSummary(state, { canResend: true }).siguiente).toMatch(/^Nada que registrar/);
    }
    expect(swaypReadingSummary(4, { canResend: true }).detalle).toBe("El mensajero la tiene y va a entregarla.");
    expect(swaypReadingSummary(2, { canResend: true }).detalle).toBe("Todavía está en la bodega de Swayp.");
  });
});

describe("el cableado", () => {
  const leer = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");

  it("el servidor rechaza el «No contesta» a mano antes de tocar la guía", () => {
    const acciones = leer("app/dashboard/envios/actions.ts");
    const cuerpo = acciones.slice(acciones.indexOf("export async function registerCourierReportResult("));
    const reja = cuerpo.indexOf("swaypInformsByApi(current) && SWAYP_API_MANUAL_EXCLUDED.has(input.result)");
    expect(reja).toBeGreaterThan(-1);
    expect(reja).toBeLessThan(cuerpo.indexOf("courierReportTransition(input.result)"));
    expect(cuerpo).toContain('.select("id,courier,guide_code,delivery_status,next_followup_at,fenix_shipment_id,swayp_guide,swayp_synced_at")');
  });

  it("el expediente trae la hora de la última lectura", () => {
    expect(leer("lib/shipments-access.ts")).toContain("swayp_guide,swayp_state,swayp_synced_at,created_via");
  });

  it("el cajón cambia el recuadro obligatorio por lo que informó Swayp, y la corrección no ofrece «No contesta»", () => {
    const ficha = leer("components/shipments.tsx");
    expect(ficha).toContain("const courierResultRequired = fenixAwaitingCourierResult && !swaypPorApi;");
    expect(ficha).toContain(") : swaypPorApi && fenixAwaitingCourierResult && !showCourierCorrection ? (");
    expect(ficha).toContain("{courierResultOptions.map((result) => (");
    expect(ficha).toContain("COURIER_REPORT_RESULTS.filter((result) => !SWAYP_API_MANUAL_EXCLUDED.has(result.code))");
  });
});
