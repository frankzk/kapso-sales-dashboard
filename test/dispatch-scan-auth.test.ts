import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: true, signedIn: true, visible: true, inRoute: true,
  checked: false, officeComplete: true, updateError: false,
  reads: [] as { client: string; table: string }[],
  writes: [] as { table: string; value: Record<string, unknown> }[],
  authCalls: 0,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect login"); } }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => state.allowed }) }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn() }));
vi.mock("@/lib/db", () => {
  const from = (client: string, table: string) => {
    let columns = "*";
    let value: Record<string, unknown> | undefined;
    const q: any = {};
    for (const method of ["eq", "in", "is", "ilike", "limit", "or"]) q[method] = () => q;
    q.select = (s: string) => { columns = s; return q; };
    q.insert = q.update = (v: Record<string, unknown>) => { value = v; return q; };
    const result = () => {
      if (value) {
        state.writes.push({ table, value });
        return { data: null, error: state.updateError && table === "dispatch_manifest_items" ? { message: "save failed" } : null };
      }
      state.reads.push({ client, table });
      const item = { id: "item", shipment_id: "shipment", removed_at: null, office_checked_at: state.checked || state.officeComplete ? "now" : null, pickup_checked_at: null };
      const data = table === "dispatch_manifests" ? (state.visible ? { id: "box", org_id: "org", state: "draft", kind: "reparto", courier: "propio" } : null)
        : table === "shipments" ? [{ id: "shipment", order_id: "order", store_id: "store", preparation_state: "listo_despacho" }]
        : table === "dispatch_manifest_items" ? (columns === "*" ? (state.inRoute ? [{ ...item, office_checked_at: state.checked ? "now" : null }] : []) : [item]) : null;
      return { data, error: null };
    };
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  };
  return {
    createServerSupabase: async () => ({ from: (table: string) => from("user", table), auth: { getUser: async () => {
      state.authCalls++;
      return { data: { user: state.signedIn ? { id: "actor" } : null } };
    } } }),
    createAdminSupabase: () => ({ from: (table: string) => from("admin", table) }),
  };
});

import { scanManifestItem } from "@/app/dashboard/pedidos/despacho/actions";

beforeEach(() => Object.assign(state, { allowed: true, signedIn: true, visible: true, inRoute: true, checked: false, officeComplete: true, updateError: false, reads: [], writes: [], authCalls: 0 }));

describe("cotejo con una autenticación por operación", () => {
  it("guarda y audita usando el mismo actor; ambas búsquedas siguen bajo RLS", async () => {
    expect(await scanManifestItem("box", "PED-001", "office")).toMatchObject({ notice: "Paquete cotejado por oficina." });
    expect(state.authCalls).toBe(1);
    expect(state.reads.filter((r) => r.client === "user").map((r) => r.table).sort()).toEqual(["dispatch_manifests", "shipments"]);
    expect(state.writes.find((w) => w.table === "dispatch_manifest_items")?.value.office_checked_by).toBe("actor");
    expect(state.writes.filter((w) => w.table.endsWith("events")).map((w) => w.value)).toEqual([
      expect.objectContaining({ actor: "actor", kind: "office_checked" }),
      expect.objectContaining({ actor: "actor", kind: "office_checked" }),
    ]);
    await scanManifestItem("box", "PED-002", "office");
    expect(state.authCalls).toBe(2); // Nunca comparte autenticación entre peticiones.
  });
  it("rechaza sin permisos antes de leer datos", async () => {
    state.allowed = false;
    expect((await scanManifestItem("box", "PED-001", "office")).error).toContain("permiso");
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("redirige al perder la sesión sin escribir", async () => {
    state.signedIn = false;
    await expect(scanManifestItem("box", "PED-001", "office")).rejects.toThrow("redirect login");
    expect(state.writes).toEqual([]);
  });
  it.each(["visible", "inRoute"] as const)("no escribe cuando %s es falso", async (field) => {
    state[field] = false;
    expect((await scanManifestItem("box", "PED-001", "office")).error).toBeTruthy();
    expect(state.writes).toEqual([]);
  });
  it("un duplicado no vuelve a escribir ni auditar", async () => {
    state.checked = true;
    expect((await scanManifestItem("box", "PED-001", "office")).notice).toContain("ya estaba");
    expect(state.writes).toEqual([]);
  });
  it("recoger sigue exigiendo el cotejo completo de oficina", async () => {
    state.officeComplete = false;
    expect((await scanManifestItem("box", "PED-001", "pickup")).error).toContain("100 %");
    expect(state.writes).toEqual([]);
  });
  it("un guardado fallido no produce confirmación ni eventos", async () => {
    state.updateError = true;
    expect((await scanManifestItem("box", "PED-001", "office")).error).toBe("save failed");
    expect(state.writes.filter((w) => w.table.endsWith("events"))).toEqual([]);
  });
});
