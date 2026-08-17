import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cacheLabel,
  labelPath,
  readCachedLabel,
  shalomLabelPdf,
  warmShalomLabel,
} from "@/lib/shalom/label-cache";

/**
 * Un almacenamiento de mentira con la superficie que usa la caché.
 *
 * `stored` empieza con lo que ya hubiera guardado; `fail` simula un bucket que
 * no responde, que es el caso que nunca puede impedir imprimir.
 */
function fakeAdmin(opts: { stored?: Uint8Array | null; fail?: boolean } = {}) {
  const uploads: { path: string; bytes: Uint8Array }[] = [];
  const storage = {
    createBucket: vi.fn(async () => ({})),
    updateBucket: vi.fn(async () => ({})),
    from: () => ({
      download: async () => {
        if (opts.fail) throw new Error("bucket caído");
        if (!opts.stored) return { data: null, error: { message: "not found" } };
        return { data: new Blob([opts.stored as BlobPart]), error: null };
      },
      upload: async (path: string, bytes: Uint8Array) => {
        if (opts.fail) throw new Error("bucket caído");
        uploads.push({ path, bytes });
        return { error: null };
      },
    }),
  };
  return { admin: { storage } as unknown as SupabaseClient, uploads };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const STORE = {} as never;

describe("la ruta de la caché identifica al documento, no al pedido", () => {
  it("se indexa por `ose_id` y nada más", () => {
    // Por eso no hace falta invalidarla nunca: si una guía se anula y el pedido
    // recibe otra, la nueva trae otro `ose_id` y por tanto otra entrada. Una
    // clave por pedido sí habría dejado servir el rótulo de la guía muerta.
    expect(labelPath(95556634)).toBe("95556634.pdf");
    expect(labelPath(1)).not.toBe(labelPath(2));
  });
});

describe("leer de la caché", () => {
  it("devuelve el PDF guardado", async () => {
    const { admin } = fakeAdmin({ stored: PDF });
    expect(await readCachedLabel(admin, 1)).toEqual(PDF);
  });

  it("sin nada guardado devuelve null, no lanza", async () => {
    const { admin } = fakeAdmin();
    expect(await readCachedLabel(admin, 1)).toBeNull();
  });

  it("un objeto vacío se ignora en vez de servirse", async () => {
    // Basura de una subida a medias: un PDF de cero bytes no lo abre ningún
    // visor, y servirlo parecería un fallo nuestro y no una caché rota.
    const { admin } = fakeAdmin({ stored: new Uint8Array() });
    expect(await readCachedLabel(admin, 1)).toBeNull();
  });

  it("un bucket caído no lanza: se vuelve a pedir y ya", async () => {
    const { admin } = fakeAdmin({ fail: true });
    expect(await readCachedLabel(admin, 1)).toBeNull();
  });
});

describe("guardar en la caché nunca puede impedir imprimir", () => {
  it("un bucket caído se traga en silencio", async () => {
    const { admin } = fakeAdmin({ fail: true });
    await expect(cacheLabel(admin, 1, PDF)).resolves.toBeUndefined();
  });

  it("no guarda un PDF vacío", async () => {
    const { admin, uploads } = fakeAdmin();
    await cacheLabel(admin, 1, new Uint8Array());
    expect(uploads).toHaveLength(0);
  });
});

describe("pedir el rótulo", () => {
  it("con caché NO llama a Shalom", async () => {
    // Es todo el punto: esa llamada cuesta ~45 s y su PDF ya no cambia.
    const { admin } = fakeAdmin({ stored: PDF });
    const client = { label: vi.fn(async () => PDF.buffer as ArrayBuffer) };
    expect(await shalomLabelPdf(admin, "st", STORE, 7, client)).toEqual(PDF);
    expect(client.label).not.toHaveBeenCalled();
  });

  it("sin caché lo pide y lo guarda para la próxima", async () => {
    const { admin, uploads } = fakeAdmin();
    const client = { label: vi.fn(async () => PDF.buffer as ArrayBuffer) };
    const out = await shalomLabelPdf(admin, "st", STORE, 7, client);
    expect(out.byteLength).toBe(PDF.byteLength);
    expect(client.label).toHaveBeenCalledWith(7);
    expect(uploads).toEqual([{ path: "7.pdf", bytes: out }]);
  });

  it("si Shalom falla, el error sube: una caché vacía no disfraza una caída", async () => {
    const { admin } = fakeAdmin();
    const client = {
      label: vi.fn(async () => {
        throw new Error("No hubo respuesta de Shalom");
      }),
    };
    await expect(shalomLabelPdf(admin, "st", STORE, 7, client)).rejects.toThrow(/Shalom/);
  });

  it("con el bucket caído sigue sirviendo lo que Shalom devolvió", async () => {
    const { admin } = fakeAdmin({ fail: true });
    const client = { label: vi.fn(async () => PDF.buffer as ArrayBuffer) };
    const out = await shalomLabelPdf(admin, "st", STORE, 7, client);
    expect(out.byteLength).toBe(PDF.byteLength);
  });
});

describe("calentar el rótulo es un adelanto, no un requisito", () => {
  it("un fallo de Shalom no se propaga a quien acaba de crear la guía", async () => {
    // La guía SÍ se creó: reventar acá convertiría un éxito en un error visible.
    const { admin } = fakeAdmin();
    const client = {
      label: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };
    await expect(
      warmShalomLabel(admin, "st", STORE, 7, client),
    ).resolves.toBeUndefined();
  });

  it("sin `ose_id` no hay nada que calentar", async () => {
    const { admin } = fakeAdmin();
    const client = { label: vi.fn(async () => PDF.buffer as ArrayBuffer) };
    await warmShalomLabel(admin, "st", STORE, null, client);
    expect(client.label).not.toHaveBeenCalled();
  });
});
