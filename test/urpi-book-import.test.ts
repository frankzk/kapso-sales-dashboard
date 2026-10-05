import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const state = vi.hoisted(() => ({
  sources: [] as Record<string, any>[],
  visible: new Set<string>(), denied: new Set<string>(), failSave: new Set<string>(),
  saves: [] as { sourceId: string; codes: string[]; origin: string }[],
  reads: 0,
}));

vi.mock("@/lib/urpi-programming-access", () => ({
  requireUrpiStore: async (storeId: string) => {
    if (state.denied.has(storeId)) throw new Error("No tienes permiso para importar programaciones.");
    return { user: { id: "actor" }, store: { id: storeId, name: storeId === "kenku" ? "Kenku Peru" : "Aurela" } };
  },
}));
vi.mock("@/lib/urpi-programming-db", () => ({
  saveUrpiProgramming: async (_admin: unknown, source: any, data: any, options: any) => {
    if (state.failSave.has(source.id)) throw new Error("Faltan pestañas de la última versión. No se reemplazó la programación.");
    state.saves.push({ sourceId: source.id, codes: data.rows.map((row: any) => row.orderCode), origin: options.origin });
    return { changed: true, rows: data.rows.length, linked: data.rows.length };
  },
}));
vi.mock("@/lib/db", () => {
  // Doble con RLS: solo se ven fuentes de tiendas accesibles.
  const from = () => {
    const filters: ((r: any) => boolean)[] = [(r) => state.visible.has(r.store_id)];
    let single = false;
    const q: any = {
      select: () => q,
      eq: (key: string, val: any) => { filters.push((r) => r[key] === val); return q; },
      neq: (key: string, val: any) => { filters.push((r) => r[key] !== val); return q; },
      maybeSingle: () => { single = true; return q; },
      then: (resolve: any) => {
        const rows = state.sources.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { createServerSupabase: async () => ({ from }), createAdminSupabase: () => ({ from }) };
});

const headers = ["Fecha de entrega", "Tipo de Envio", "Código de pedido", "Destinatario", "Número de contacto", "Provincia", "Distrito", "Dirección", "Producto a entregar", "Monto a Cobrar"];
const row = (code: string) => ["01/10/26", "Primer Turno", code, "Cliente", "900000000", "Lima", "Rímac", "Dirección", "1 Producto", "149.00"];
const tabs = [{ title: "01/10/26", sheetId: 1, values: [headers, row("#KP100"), row("#AUR200"), row("#KP101")] }];
vi.mock("@/lib/urpi-google-sheets", () => ({
  readUrpiGoogleWorkbook: async () => { state.reads++; return { title: "Octubre", tabs }; },
}));

vi.mock("@/lib/urpi-excel", () => ({
  readUrpiExcelWorkbook: async () => { state.reads++; return tabs; },
}));

import { syncUrpiSource } from "@/app/dashboard/urpi/actions";
import { POST as importExcel } from "@/app/api/urpi/programming/import/route";

const book = { spreadsheet_id: "13v6LVlETx17NWAN1jgWJzCHxR-7GoWOHk3llf2RzAgc", month: "2026-10" };
beforeEach(() => {
  state.sources = [
    { id: "src-kp", store_id: "kenku", order_prefix: "KP", name: "Kenku Peru · 2026-10", ...book },
    { id: "src-aur", store_id: "aurela", order_prefix: "AUR", name: "Aurela · 2026-10", ...book },
    { id: "src-other", store_id: "aurela", order_prefix: "AUR", name: "Aurela · 2026-09", ...book, month: "2026-09" },
  ];
  state.visible = new Set(["kenku", "aurela"]);
  state.denied.clear(); state.failSave.clear();
  state.saves = []; state.reads = 0;
});

describe("Actualizar desde Google con un libro mixto", () => {
  it("lee el Sheet una vez y guarda cada tienda con solo sus pedidos", async () => {
    const result = await syncUrpiSource("src-kp");
    expect(state.reads).toBe(1);
    expect(state.saves).toEqual([
      { sourceId: "src-kp", codes: ["KP100", "KP101"], origin: "google" },
      { sourceId: "src-aur", codes: ["AUR200"], origin: "google" },
    ]);
    expect(result).toMatchObject({ ok: true, saved: 2 });
    expect(result.message).toBe("Kenku Peru (KP): Programación actualizada: 2 registros, 2 vinculados a Kapta.\nAurela (AUR): Programación actualizada: 1 registros, 1 vinculados a Kapta.");
  });
  it("una tienda sola mantiene el mensaje de siempre", async () => {
    state.sources = state.sources.filter((source) => source.id !== "src-aur");
    const result = await syncUrpiSource("src-kp");
    expect(result).toEqual({ ok: true, saved: 1, message: "Programación actualizada: 2 registros, 2 vinculados a Kapta." });
  });
  it("no toca la tienda hermana sin permiso y lo informa", async () => {
    state.denied.add("aurela");
    const result = await syncUrpiSource("src-kp");
    expect(state.saves.map((save) => save.sourceId)).toEqual(["src-kp"]);
    expect(result.message).toContain("Aurela · 2026-10: sin permiso para importar; no se modificó.");
  });
  it("no ve ni importa la tienda que el usuario no puede leer", async () => {
    state.visible = new Set(["kenku"]);
    const result = await syncUrpiSource("src-kp");
    expect(state.saves.map((save) => save.sourceId)).toEqual(["src-kp"]);
    expect(result.message).not.toContain("Aurela");
  });
  it("sin permiso en la tienda pedida no lee Google", async () => {
    state.denied.add("kenku");
    const result = await syncUrpiSource("src-kp");
    expect(result.ok).toBe(false);
    expect(state.reads).toBe(0);
    expect(state.saves).toEqual([]);
  });
  it("el fallo de una tienda no impide guardar la otra", async () => {
    state.failSave.add("src-kp");
    const result = await syncUrpiSource("src-kp");
    expect(state.saves.map((save) => save.sourceId)).toEqual(["src-aur"]);
    expect(result).toMatchObject({ ok: false, saved: 1 });
    expect(result.message).toContain("Kenku Peru (KP): Faltan pestañas");
  });
});

describe("Cargar Excel del mes con un libro mixto", () => {
  const upload = (sourceId: string) => {
    const form = new FormData();
    form.set("sourceId", sourceId);
    form.set("file", new File([new Uint8Array([1])], "Urpi octubre.xlsx"));
    return importExcel(new Request("http://kapta.test/api/urpi/programming/import", { method: "POST", body: form }));
  };
  it("reparte el Excel entre las tiendas del libro", async () => {
    const res = await upload("src-aur");
    expect(res.status).toBe(200);
    expect(state.saves).toEqual([
      { sourceId: "src-aur", codes: ["AUR200"], origin: "excel" },
      { sourceId: "src-kp", codes: ["KP100", "KP101"], origin: "excel" },
    ]);
    expect(await res.json()).toMatchObject({ ok: true, saved: 2 });
  });
  it("sin permiso en la tienda pedida no lee el archivo", async () => {
    state.denied.add("aurela");
    const res = await upload("src-aur");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "No tienes permiso para importar programaciones." });
    expect(state.reads).toBe(0);
  });
  it("informa el éxito parcial con lo guardado", async () => {
    state.failSave.add("src-kp");
    const res = await upload("src-aur");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ saved: 1, error: expect.stringContaining("Kenku Peru (KP): Faltan pestañas") });
  });
});
