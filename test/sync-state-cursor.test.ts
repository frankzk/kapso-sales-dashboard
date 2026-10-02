import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSyncCursor, recordSyncError } from "@/lib/ingest";

// El cursor de cada sincronización sobrevive a sus errores (02-10-2026).
//
// Al fallar, las pasadas de Shopify, carritos y Kapso escribían `cursor: null`,
// y la siguiente recorría todo desde el principio justo cuando la base no daba
// abasto. Y una lectura fallida del cursor se tomaba por «no hay cursor», con el
// mismo resultado.

type Reply = { data: unknown; error: { message: string } | null };

function fakeSupabase(reply: Reply = { data: null, error: null }) {
  const writes: { payload: Record<string, unknown>; opts: unknown }[] = [];
  const from = (table: string) => {
    expect(table).toBe("sync_state");
    const b: Record<string, unknown> = {};
    for (const m of ["select", "match", "maybeSingle"]) b[m] = () => b;
    b.upsert = (payload: Record<string, unknown>, opts: unknown) => {
      writes.push({ payload, opts });
      return Promise.resolve({ data: null, error: null });
    };
    b.then = (resolve: (r: Reply) => unknown) => Promise.resolve(reply).then(resolve);
    return b;
  };
  return { client: { from } as never, writes };
}

describe("getSyncCursor", () => {
  it("devuelve el cursor guardado, o null si la pasada nunca corrió", async () => {
    expect(await getSyncCursor(fakeSupabase({ data: { cursor: "2026-10-01T23:00:00Z" }, error: null }).client, "s", "kapso")).toBe(
      "2026-10-01T23:00:00Z",
    );
    expect(await getSyncCursor(fakeSupabase({ data: null, error: null }).client, "s", "kapso")).toBeNull();
  });

  it("si no puede leerlo, lanza: «no pude leer» no es «empezar desde cero»", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "521 origin down" } });
    await expect(getSyncCursor(client, "s", "shopify")).rejects.toThrow("cursor de shopify: 521 origin down");
  });
});

describe("recordSyncError", () => {
  it("registra el error sin tocar el cursor", async () => {
    const { client, writes } = fakeSupabase();
    await recordSyncError(client, "store-1", "kapso", "canceling statement due to statement timeout");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.payload).toMatchObject({
      store_id: "store-1",
      source: "kapso",
      status: "error",
      error: "canceling statement due to statement timeout",
    });
    // Sin la columna, el upsert conserva el cursor que la fila ya tenía.
    expect("cursor" in writes[0]!.payload).toBe(false);
    expect(writes[0]!.opts).toEqual({ onConflict: "store_id,source" });
  });
});

describe("runStoreSync: los catch de cada pasada", () => {
  const src = readFileSync(join(process.cwd(), "lib/ingest.ts"), "utf8");

  it("registran el error con recordSyncError en las cuatro pasadas con cursor", () => {
    for (const source of ["shopify", "shopify_all", "shopify_drafts", "kapso"]) {
      expect(src).toContain(`await recordSyncError(admin, storeId, "${source}", e.message);`);
    }
  });

  it("ninguna escribe un cursor nulo en sync_state", () => {
    expect(src).not.toMatch(/setSyncState\(/);
    expect(src).not.toMatch(/recordSyncOk\(admin, storeId, "[a-z_]+", null\)/);
  });
});
