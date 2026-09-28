import { describe, expect, it, vi } from "vitest";

/**
 * «RECIBIR MI CAJA» CON LA CAJA TODAVÍA EN COTEJO (0196, MOM §29.2).
 *
 * A la caja del motorizado se le siguen sumando paquetes mientras oficina la
 * coteja. Si la pantalla solo mostrara cajas con oficina al 100 %, una caja que
 * vuelve a cotejo porque le sumaron un paquete desaparecería del teléfono en
 * plena recepción. Y si mostrara cualquier caja en cotejo, el teléfono cambiaría
 * de pantalla antes de que haya nada que escanear.
 */

const { estado } = vi.hoisted(() => ({
  estado: {
    cargas: [] as { id: string; route_date: string; load_number: number; state: string }[],
    items: {} as Record<string, unknown[]>,
    estadosPedidos: [] as unknown[],
  },
}));

function query(tabla: string) {
  const filtros: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (columna: string, valor: unknown) => {
    filtros[columna] = valor;
    return q;
  };
  q.in = (columna: string, valores: unknown[]) => {
    if (tabla === "dispatch_manifests" && columna === "state") estado.estadosPedidos = valores;
    return q;
  };
  q.order = () => q;
  q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
    const data = tabla === "dispatch_manifests" ? estado.cargas : estado.items[String(filtros.manifest_id)] ?? [];
    return Promise.resolve({ data, error: null }).then(ok, fail);
  };
  return q;
}

vi.mock("@/lib/db", () => ({ createAdminSupabase: () => ({ from: (tabla: string) => query(tabla) }) }));
vi.mock("@/lib/routes-access", () => ({ getMyRider: async () => ({ id: "rider-yhoni", full_name: "Yhoni" }) }));
vi.mock("@/lib/grupo-gf-courier-route-access", () => ({ riderPickupMode: async () => "exigir" }));

import { getMyGfLoads } from "@/lib/gf-rider-loads";

const paquete = (id: string, cotejo: { office?: string | null; pickup?: string | null; removed?: string | null } = {}) => ({
  id,
  shipment_id: `s-${id}`,
  office_checked_at: cotejo.office ?? null,
  pickup_checked_at: cotejo.pickup ?? null,
  pickup_declined_at: null,
  pickup_declined_reason: null,
  removed_at: cotejo.removed ?? null,
  shipments: { order_id: `o-${id}`, order_name: `#${id}`, customer_name: "Cliente", district: "Surco", output_code: `${id}-S01`, guide_code: null },
});

describe("las cajas que ve el motorizado en «Recibir mi caja»", () => {
  it("pide también las cajas en cotejo de oficina, no solo las verificadas al 100 %", async () => {
    estado.cargas = [];
    await getMyGfLoads();
    expect(estado.estadosPedidos).toEqual(["office_check", "ready_for_pickup", "pickup_check"]);
  });

  it("muestra la caja en cotejo con algo verificado y esconde la que oficina aún no empieza", async () => {
    estado.cargas = [
      { id: "caja-en-cotejo", route_date: "2026-09-28", load_number: 1, state: "office_check" },
      { id: "caja-sin-empezar", route_date: "2026-09-28", load_number: 2, state: "office_check" },
      { id: "caja-lista", route_date: "2026-09-27", load_number: 1, state: "ready_for_pickup" },
    ];
    estado.items = {
      "caja-en-cotejo": [paquete("P1", { office: "t", pickup: "t" }), paquete("P2", { office: "t" }), paquete("P3")],
      "caja-sin-empezar": [paquete("P4"), paquete("P5")],
      "caja-lista": [paquete("P6", { office: "t" })],
    };
    const cajas = await getMyGfLoads();
    expect(cajas.map((c) => c.id)).toEqual(["caja-en-cotejo", "caja-lista"]);

    const enCotejo = cajas[0]!;
    expect(enCotejo.total).toBe(3);
    expect(enCotejo.received).toBe(1);
    // P3 espera a oficina; P2 ya se puede recibir.
    expect(enCotejo.awaitingOffice).toBe(1);
    expect(enCotejo.items.find((i) => i.id === "P3")?.office_checked_at).toBeNull();
    expect(enCotejo.items.find((i) => i.id === "P2")?.office_checked_at).toBe("t");
  });

  it("lo único verificado, si se retiró, no abre la pantalla", async () => {
    estado.cargas = [{ id: "caja", route_date: "2026-09-28", load_number: 1, state: "office_check" }];
    estado.items = { caja: [paquete("P1", { office: "t", removed: "t" }), paquete("P2")] };
    expect(await getMyGfLoads()).toEqual([]);
  });
});
