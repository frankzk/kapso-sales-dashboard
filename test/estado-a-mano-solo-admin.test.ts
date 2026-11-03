// «Solo quienes tienen acceso de Admin pueden realizar esa acción» — decisión
// del dueño del 15-10-2026 sobre «Gestión manual → Registrar estado» (MOM §16).
//
// Cambiar a mano el estado de un pedido pedía `master.edit`, que tienen la
// vendedora y los siete roles por función. Un estado a mano CONGELA el pedido
// frente al recálculo (§6.1). Lo que se fija aquí, contra la acción de verdad
// (la base va simulada; los permisos, no):
//   - vendedora y Supervisión (que corrige cierres) reciben el rechazo y no se
//     escribe nada; owner y admin, sí;
//   - se pregunta en la organización DEL PEDIDO: ser admin en otra empresa no
//     sirve;
//   - el lote no intenta ni un pedido sin el permiso;
//   - comentar y registrar devoluciones siguen siendo de quien gestiona pedidos.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const st = vi.hoisted(() => ({
  user: "u-1",
  tables: {} as Record<string, Row[]>,
  writes: [] as { table: string; op: string; value: any }[],
  reads: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/order-master", () => ({
  recomputeOrderMasterSafe: vi.fn(async () => {}),
  applyConfirmationCycleToStore: vi.fn(async () => {}),
}));
// Quién es y en qué organizaciones: lo que `lib/access` lee de `memberships`.
vi.mock("@/lib/access", () => ({
  getCurrentUser: async () => ({ id: st.user }),
  getUserRoleSummary: async () => {
    const roles = (st.tables.memberships ?? []).filter((m) => m.user_id === st.user).map((m) => String(m.role));
    return { roles, isVendedoraOnly: false, isRiderOnly: false };
  },
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let op: "select" | "insert" | "update" = "select";
    let value: any;
    let single = false;
    const q: any = {
      select: () => q,
      eq: (key: string, val: unknown) => {
        filters.push([key, val]);
        return q;
      },
      in: () => q,
      order: () => q,
      limit: () => q,
      insert: (row: any) => {
        op = "insert";
        value = row;
        return q;
      },
      update: (row: any) => {
        op = "update";
        value = row;
        return q;
      },
      maybeSingle: () => {
        single = true;
        return q;
      },
      single: () => {
        single = true;
        return q;
      },
      then: (ok: any, ko: any) => {
        if (op !== "select") {
          st.writes.push({ table, op, value });
          return Promise.resolve({ data: null, error: null }).then(ok, ko);
        }
        st.reads.push(table);
        const rows = (st.tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null, count: rows.length }).then(ok, ko);
      },
    };
    return q;
  };
  const client = { from, auth: { getUser: async () => ({ data: { user: { id: st.user } }, error: null }) } };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { SET_STATUS_DENIED } from "@/lib/order-status";
import {
  addOrderComment,
  applyOrderStatusBulk,
  registerReturn,
  setOrderStatus,
} from "@/app/dashboard/pedidos/actions";

const ORDER = "order-a";

function seed(
  memberships: { org_id: string; role: string }[],
  functions: { org_id: string; role: string }[] = [],
  order: Partial<Row> = {},
) {
  st.writes = [];
  st.reads = [];
  st.tables = {
    memberships: memberships.map((m) => ({ user_id: st.user, ...m })),
    membership_roles: functions.map((f) => ({ user_id: st.user, ...f })),
    user_permissions: [],
    stores: [
      { id: "store-a", org_id: "org-a" },
      { id: "store-b", org_id: "org-b" },
    ],
    order_master: [
      {
        order_id: ORDER,
        order_name: "#KP150001",
        store_id: "store-a",
        general_status: "en_proceso",
        operational_status: "en_ruta",
        coverage: "lima",
        guide_code: "AUR5X150001",
        dispatched_at: "2026-10-14T15:00:00Z",
        ...order,
      },
    ],
    shipments: [],
    order_events: [],
  };
}

const statusWrites = () => st.writes.filter((w) => w.table === "order_events" && w.value?.kind === "status_override");

beforeEach(() => {
  st.user = "u-1";
});

describe("«Registrar estado» desde la ficha", () => {
  it("una vendedora (gestiona pedidos) recibe el rechazo y no se escribe nada", async () => {
    seed([{ org_id: "org-a", role: "vendedora" }]);
    expect(await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" })).toEqual({ error: SET_STATUS_DENIED });
    expect(st.writes).toEqual([]);
    // Ni siquiera llega a leer las salidas: el permiso va antes de todo lo demás.
    expect(st.reads).not.toContain("shipments");
  });

  it("Supervisión tampoco: corrige pedidos cerrados, pero no tiene acceso de admin", async () => {
    seed([{ org_id: "org-a", role: "vendedora" }], [{ org_id: "org-a", role: "supervision" }]);
    expect(await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" })).toEqual({ error: SET_STATUS_DENIED });
    // Y sobre un pedido cerrado, con motivo, igual: no es la regla de cierres la que manda aquí.
    seed([{ org_id: "org-a", role: "vendedora" }], [{ org_id: "org-a", role: "supervision" }], {
      general_status: "entregado",
      operational_status: "entregado",
    });
    expect(
      await setOrderStatus(ORDER, { general: "en_proceso", operational: "en_ruta", reason: "la clienta no lo recibió" }),
    ).toEqual({ error: SET_STATUS_DENIED });
    expect(st.writes).toEqual([]);
  });

  it("todos los roles por función juntos, tampoco", async () => {
    const all = ["asesora", "almacen", "despacho", "liquidaciones", "cobranza", "supervision", "administracion"];
    seed([{ org_id: "org-a", role: "vendedora" }], all.map((role) => ({ org_id: "org-a", role })));
    expect(await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" })).toEqual({ error: SET_STATUS_DENIED });
    expect(st.writes).toEqual([]);
  });

  it("un admin de la organización lo registra", async () => {
    seed([{ org_id: "org-a", role: "admin" }]);
    const result = await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" });
    expect(result.error).toBeUndefined();
    expect(result.notice).toMatch(/Estado actualizado a entregado/);
    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0]!.value).toMatchObject({ order_id: ORDER, new_status: "entregado", actor: "u-1", previous_status: "en_proceso" });
  });

  it("el owner también", async () => {
    seed([{ org_id: "org-a", role: "owner" }]);
    expect((await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" })).notice).toMatch(/Estado actualizado/);
    expect(statusWrites()).toHaveLength(1);
  });

  it("ser admin en OTRA organización no sirve en un pedido donde se es vendedora", async () => {
    seed([
      { org_id: "org-b", role: "admin" },
      { org_id: "org-a", role: "vendedora" },
    ]);
    expect(await setOrderStatus(ORDER, { general: "entregado", operational: "entregado" })).toEqual({ error: SET_STATUS_DENIED });
    expect(st.writes).toEqual([]);
  });

  it("al admin la regla de pedidos cerrados le sigue pidiendo el motivo", async () => {
    seed([{ org_id: "org-a", role: "admin" }], [], { general_status: "entregado", operational_status: "entregado" });
    expect(await setOrderStatus(ORDER, { general: "en_proceso", operational: "en_ruta" })).toEqual({
      error: "Describe el motivo del cambio: quedará en el historial.",
    });
    expect(st.writes).toEqual([]);
    expect((await setOrderStatus(ORDER, { general: "en_proceso", operational: "en_ruta", reason: "no lo recibió" })).notice).toMatch(
      /Estado actualizado/,
    );
  });

  it("sin «Gestionar pedidos» el mensaje sigue siendo el de siempre", async () => {
    seed([{ org_id: "org-a", role: "viewer" }]);
    expect(await setOrderStatus(ORDER, { general: "entregado" })).toEqual({ error: "Tu rol no permite modificar pedidos." });
  });
});

describe("«Registrar estado…» en lote", () => {
  it("sin el permiso no se intenta ningún pedido, ni el comentario", async () => {
    seed([{ org_id: "org-a", role: "vendedora" }]);
    expect(await applyOrderStatusBulk([ORDER], { general: "entregado", operational: "entregado", comment: "PAGADO" })).toEqual({
      error: SET_STATUS_DENIED,
      applied: [],
      failed: [],
    });
    expect(st.writes).toEqual([]);
  });

  it("admin en otra organización: cada pedido se rechaza en la suya y no se escribe nada", async () => {
    seed([
      { org_id: "org-b", role: "admin" },
      { org_id: "org-a", role: "vendedora" },
    ]);
    const result = await applyOrderStatusBulk([ORDER], { general: "entregado", operational: "entregado", comment: "PAGADO" });
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([{ orderId: ORDER, error: SET_STATUS_DENIED }]);
    expect(st.writes).toEqual([]);
  });

  it("un admin lo aplica con su comentario", async () => {
    seed([{ org_id: "org-a", role: "admin" }]);
    const result = await applyOrderStatusBulk([ORDER], { general: "entregado", operational: "entregado", comment: "PAGADO" });
    expect(result.applied).toEqual([ORDER]);
    expect(statusWrites()).toHaveLength(1);
    expect(st.writes.some((w) => w.value?.kind === "comment" && w.value?.note === "PAGADO")).toBe(true);
  });
});

describe("el resto de «Gestión manual» sigue con «Gestionar pedidos»", () => {
  it("la vendedora comenta", async () => {
    seed([{ org_id: "org-a", role: "vendedora" }]);
    expect(await addOrderComment(ORDER, { text: "No contesta, se llama mañana" })).toEqual({ notice: "Comentario registrado." });
    expect(st.writes.filter((w) => w.value?.kind === "comment")).toHaveLength(1);
  });

  it("y registra la devolución de un pedido en curso", async () => {
    seed([{ org_id: "org-a", role: "vendedora" }]);
    expect(await registerReturn(ORDER, { reason: "rechazado en puerta" })).toEqual({ notice: "Devolución registrada." });
    expect(st.writes.map((w) => w.value?.kind)).toEqual(["returned", "status_override"]);
  });
});

describe("MOM §16 dice lo mismo que el código", () => {
  it("la decisión del dueño, con su fecha, el permiso, quién lo tiene y que lo exige el servidor", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    const section = mom.slice(mom.indexOf("## 16. Permisos de alto riesgo"), mom.indexOf("### 16.1 Bandeja de validación de pagos"));
    expect(section).toContain("**El estado a mano es de un admin (15-10-2026).**");
    expect(section).toContain("«solo quienes tienen acceso de Admin pueden realizar esa acción»");
    expect(section).toContain("**Permiso propio: `master.set_status`** («Registrar estado a mano»)");
    expect(section).toContain("**owner y admin por su acceso**");
    expect(section).toContain("**Lo exige el servidor**, en la **organización del pedido**");
    expect(section).toContain(`Responde «${SET_STATUS_DENIED}»`);
    // La tabla de roles no puede seguir leyéndose como si «Gestionar pedidos» cambiara estados.
    expect(section).toContain("«Gestionar pedidos» ya **no** incluye cambiar el estado a mano");
  });
});
