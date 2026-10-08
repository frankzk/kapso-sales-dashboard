// Reenvío por Swayp desde una guía Swayp EN DEVOLUCIÓN (MOM §11.8, 08-10-2026).
//
// #KP135202 (Arequipa): Swayp no entregó la guía 50000137273 y la marcó en
// Devolución (8). La recuperación se abrió, el agente llamó el 05/10 y la
// clienta aceptó el reenvío para el 07/10, pero no salió nada: el reenvío pedía
// una guía ANULADA y la de Swayp sigue `en_ruta` mientras el paquete vuelve.
// Ahora esa guía también es madre del reenvío, en provincia y con Swayp
// confirmando que sigue en devolución.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { swaypEnabled: () => false, swaypSenders: () => "" } }));

import {
  confirmarDevolucionSwayp,
  elegirOrigenReenvio,
  origenReenvioSwayp,
  reenviarGuiaAnulada,
} from "@/lib/swayp-reenvio";

const swayp = (swayp_state: number | null, extra: Record<string, unknown> = {}) => ({
  courier: "fenix",
  delivery_status: "en_ruta",
  swayp_state,
  fenix_shipment_id: null as string | null,
  ...extra,
});

describe("origenReenvioSwayp", () => {
  it("la guía anulada sin reemplazo es la madre de siempre, en Lima o en provincia", () => {
    const aliclik = { courier: "aliclik", delivery_status: "anulado", fenix_shipment_id: null };
    expect(origenReenvioSwayp(aliclik, "provincia_cod")).toBe("anulada");
    expect(origenReenvioSwayp(aliclik, null)).toBe("anulada");
    expect(origenReenvioSwayp({ ...aliclik, fenix_shipment_id: "hija" }, "provincia_cod")).toBeNull();
  });

  it("#KP135202: una Swayp en devolución (8), en provincia, también", () => {
    expect(origenReenvioSwayp(swayp(8), "provincia_cod")).toBe("swayp_en_devolucion");
  });

  it("en Lima no: Swayp va una sola vez por pedido y el reintento es de Grupo GF", () => {
    expect(origenReenvioSwayp(swayp(8), "lima")).toBeNull();
  });

  it("sin la modalidad del Master no se adivina", () => {
    expect(origenReenvioSwayp(swayp(8), null)).toBeNull();
    expect(origenReenvioSwayp(swayp(8), undefined)).toBeNull();
    expect(origenReenvioSwayp(swayp(8), "desconocida")).toBeNull();
  });

  it("una Swayp viva —en reparto, con novedad o sin estado— no es madre de nada", () => {
    for (const state of [1, 4, 5, 6, null]) {
      expect(origenReenvioSwayp(swayp(state), "provincia_cod")).toBeNull();
    }
  });

  it("ya reemplazada, entregada o pendiente, tampoco", () => {
    expect(origenReenvioSwayp(swayp(8, { fenix_shipment_id: "hija" }), "provincia_cod")).toBeNull();
    expect(origenReenvioSwayp(swayp(8, { delivery_status: "entregado" }), "provincia_cod")).toBeNull();
    expect(origenReenvioSwayp(swayp(8, { delivery_status: "pendiente" }), "provincia_cod")).toBeNull();
  });

  it("solo Swayp: un `en_ruta` de otro courier no es su devolución", () => {
    expect(origenReenvioSwayp(swayp(8, { courier: "tanders" }), "provincia_cod")).toBeNull();
    expect(origenReenvioSwayp(swayp(8, { courier: "aliclik" }), "provincia_cod")).toBeNull();
    expect(origenReenvioSwayp(swayp(8, { courier: null }), "provincia_cod")).toBeNull();
  });
});

describe("elegirOrigenReenvio", () => {
  const anulada = (id: string, updated_at: string, extra: Record<string, unknown> = {}) => ({
    id,
    courier: "aliclik",
    delivery_status: "anulado",
    fenix_shipment_id: null as string | null,
    updated_at,
    ...extra,
  });

  it("la anulada gana, y entre anuladas la más reciente", () => {
    const guias = [
      { id: "dev", ...swayp(8), updated_at: "2026-10-08T00:00:00Z" },
      anulada("vieja", "2026-09-01T00:00:00Z"),
      anulada("nueva", "2026-09-20T00:00:00Z"),
    ];
    expect(elegirOrigenReenvio(guias, "provincia_cod")?.id).toBe("nueva");
  });

  it("sin anulada, la Swayp en devolución más reciente", () => {
    const guias = [
      anulada("reemplazada", "2026-09-20T00:00:00Z", { fenix_shipment_id: "hija" }),
      { id: "dev-vieja", ...swayp(8), updated_at: "2026-09-25T00:00:00Z" },
      { id: "dev-nueva", ...swayp(8), updated_at: "2026-10-05T00:00:00Z" },
      { id: "viva", ...swayp(5), updated_at: "2026-10-08T00:00:00Z" },
    ];
    expect(elegirOrigenReenvio(guias, "provincia_cod")?.id).toBe("dev-nueva");
    expect(elegirOrigenReenvio(guias, "lima")).toBeNull();
  });

  it("sin candidatas, nada", () => {
    expect(elegirOrigenReenvio([], "provincia_cod")).toBeNull();
  });
});

describe("confirmarDevolucionSwayp", () => {
  it("Devolución, Devolución confirmada o con cobro: sigue", async () => {
    for (const estado of [8, 9, 12]) {
      expect(await confirmarDevolucionSwayp("50000137273", async () => estado)).toEqual({ ok: true });
    }
  });

  it("si la vendedora la devolvió a reparto, no se pide otra guía", async () => {
    const r = await confirmarDevolucionSwayp("50000137273", async () => 5);
    expect(r).toEqual({ error: expect.stringContaining("ya no tiene la guía 50000137273 en devolución (estado 5)") });
  });

  it("si Swayp no la encuentra o no responde, no se adivina", async () => {
    expect(await confirmarDevolucionSwayp("50000137273", async () => null)).toEqual({
      error: expect.stringContaining("ya no tiene la guía 50000137273 en devolución."),
    });
    const caida = await confirmarDevolucionSwayp("50000137273", async () => {
      throw new Error("503");
    });
    expect(caida).toEqual({ error: expect.stringContaining("No se pudo confirmar con Swayp") });
    expect(caida).toEqual({ error: expect.stringContaining("(503)") });
  });

  it("sin número no hay a quién preguntar", async () => {
    const leer = vi.fn(async () => 8);
    expect(await confirmarDevolucionSwayp(null, leer)).toEqual({ error: expect.stringContaining("no tiene número") });
    expect(leer).not.toHaveBeenCalled();
  });
});

/** Base de mentira: la guía y la modalidad del Master; cualquier escritura queda anotada. */
function fakeAdmin(guia: Record<string, unknown>, operation: string | null) {
  const writes: string[] = [];
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
    for (const m of ["insert", "update", "delete", "upsert"]) {
      q[m] = () => {
        writes.push(`${table}:${m}`);
        return q;
      };
    }
    // Un alta en esta base no devuelve fila: la hija no se crea, sin error de reja.
    q.single = async () => ({ data: null, error: { message: "alta de prueba" } });
    q.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    q.maybeSingle = async () => ({
      data: table === "shipments" ? guia : table === "order_master" ? { macro_operation: operation } : null,
      error: null,
    });
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, writes };
}

describe("reenviarGuiaAnulada desde una guía Swayp en devolución", () => {
  const KP135202 = {
    id: "ship-swayp",
    courier: "fenix",
    guide_code: "50000137273",
    swayp_guide: "50000137273",
    delivery_status: "en_ruta",
    swayp_state: 8,
    fenix_shipment_id: null,
    order_id: "order-1",
    order_name: "#KP135202",
    city: null,
    district: "mariano melgar",
    province: "Arequipa",
    region: "Arequipa",
    product: "Sérum",
    fenix_eligible: true,
  };
  const ctx = { userId: "u1", storeId: "store-1" };
  const input = { nextFollowupAt: "2099-10-09T00:00:00.000Z", note: "La clienta aceptó el reenvío." };

  it("si Swayp ya no la tiene en devolución, no pide otra guía ni escribe nada", async () => {
    const { admin, writes } = fakeAdmin(KP135202, "provincia_cod");
    const leer = vi.fn(async () => 5);
    const r = await reenviarGuiaAnulada(admin, ctx, "ship-swayp", input, { leerEstadoSwayp: leer });
    expect(leer).toHaveBeenCalledWith("50000137273");
    expect(r).toEqual({ error: expect.stringContaining("ya no tiene la guía 50000137273 en devolución") });
    expect(writes).toEqual([]);
  });

  it("en Lima lo dice: el reintento es de Grupo GF, y ni le pregunta a Swayp", async () => {
    const { admin, writes } = fakeAdmin(KP135202, "lima");
    const leer = vi.fn(async () => 8);
    const r = await reenviarGuiaAnulada(admin, ctx, "ship-swayp", input, { leerEstadoSwayp: leer });
    expect(r).toEqual({
      error:
        "En Lima, lo que Swayp no entregó se reprograma con Grupo GF («Por reprogramar Lima»): Swayp va una sola vez por pedido.",
    });
    expect(leer).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("una Swayp viva no es una devolución: «ya cambió de estado»", async () => {
    const { admin } = fakeAdmin({ ...KP135202, swayp_state: 5 }, "provincia_cod");
    const leer = vi.fn(async () => 5);
    const r = await reenviarGuiaAnulada(admin, ctx, "ship-swayp", input, { leerEstadoSwayp: leer });
    expect(r).toEqual({ error: expect.stringContaining("ya cambió de estado") });
    expect(leer).not.toHaveBeenCalled();
  });

  it("ya reemplazada, lo dice con su número", async () => {
    const { admin } = fakeAdmin({ ...KP135202, fenix_shipment_id: "hija" }, "provincia_cod");
    const r = await reenviarGuiaAnulada(admin, ctx, "ship-swayp", input, { leerEstadoSwayp: async () => 8 });
    expect(r).toEqual({ error: "La guía 50000137273 ya tiene una guía Swayp de reemplazo." });
  });

  it("confirmada la devolución, sigue a las rejas de siempre (aquí, Swayp apagado)", async () => {
    const { admin, writes } = fakeAdmin(KP135202, "provincia_cod");
    const r = await reenviarGuiaAnulada(admin, ctx, "ship-swayp", input, { leerEstadoSwayp: async () => 8 });
    // Pasó la reja del origen y la de Swayp: lo que lo para ya es la siguiente.
    expect(r).not.toEqual({ error: expect.stringContaining("devolución") });
    expect(r).not.toEqual({ error: expect.stringContaining("cambió de estado") });
    expect(writes).not.toContain("shipments:insert");
  });
});

describe("spinOffFenixGuide con la madre en devolución", () => {
  const madre = {
    courier: "fenix",
    delivery_status: "en_ruta",
    swayp_state: 8,
    fenix_shipment_id: null,
    store_id: "store-1",
    order_id: null,
    order_name: "#KP135202",
  };
  const ctx = { userId: "u1", storeId: "store-1" };

  it("sin decir que es una devolución, sigue pidiendo el resultado del courier", async () => {
    const { spinOffFenixGuide } = await import("@/lib/swayp-reenvio");
    const { admin } = fakeAdmin(madre, "provincia_cod");
    expect(await spinOffFenixGuide(admin, ctx, "ship-swayp", "50000999999", {})).toEqual({
      error: expect.stringContaining("Primero registra el resultado del courier"),
    });
  });

  it("con la devolución dicha y guardada, el resultado ya se sabe y pasa", async () => {
    const { spinOffFenixGuide } = await import("@/lib/swayp-reenvio");
    const { admin } = fakeAdmin(madre, "provincia_cod");
    const r = await spinOffFenixGuide(admin, ctx, "ship-swayp", "50000999999", { origenEnDevolucion: true });
    expect(r).not.toEqual({ error: expect.stringContaining("Primero registra el resultado del courier") });
  });

  it("decirlo no basta si la madre guardada ya no está en devolución", async () => {
    const { spinOffFenixGuide } = await import("@/lib/swayp-reenvio");
    const { admin } = fakeAdmin({ ...madre, swayp_state: 5 }, "provincia_cod");
    expect(await spinOffFenixGuide(admin, ctx, "ship-swayp", "50000999999", { origenEnDevolucion: true })).toEqual({
      error: expect.stringContaining("Primero registra el resultado del courier"),
    });
  });
});

describe("el cableado: botón, agente y ficha usan la misma regla", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const leer = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
  const reenvio = leer("lib/swayp-reenvio.ts");
  const cuerpo = reenvio.slice(reenvio.indexOf("export async function reenviarGuiaAnulada("));
  const buscar = reenvio.slice(reenvio.indexOf("export async function buscarOrigenReenvio("));

  it("la madre se transfiere desde el estado en que se leyó, diciendo si era una devolución", () => {
    expect(cuerpo).toContain("expectedSourceStatus: current.delivery_status,");
    expect(cuerpo).toContain('origenEnDevolucion: origen === "swayp_en_devolucion",');
  });

  it("Swayp confirma la devolución ANTES de emitir la guía nueva", () => {
    expect(cuerpo.indexOf("confirmarDevolucionSwayp(")).toBeGreaterThan(-1);
    expect(cuerpo.indexOf("confirmarDevolucionSwayp(")).toBeLessThan(cuerpo.indexOf("swaypGuideForReprogram("));
  });

  it("la búsqueda de la madre mira anuladas y en ruta sin reemplazo, con la modalidad del Master", () => {
    expect(buscar).toContain('.in("delivery_status", ["anulado", "en_ruta"])');
    expect(buscar).toContain('.is("fenix_shipment_id", null)');
    expect(buscar).toContain('from("order_master").select("macro_operation")');
  });

  it("la ficha de Envíos ofrece el reenvío con la misma función", () => {
    const acciones = leer("app/dashboard/envios/actions.ts");
    expect(acciones).toContain('origenReenvioSwayp(\n        detail.shipment,');
    expect(acciones).toContain('=== "swayp_en_devolucion";');
    const ficha = leer("components/shipments.tsx");
    expect(ficha).toContain('(detail.shipment.delivery_status === "anulado" || reenvioDesdeDevolucion) && (');
  });
});
