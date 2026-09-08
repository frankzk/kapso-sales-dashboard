import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cacheLabel,
  labelPath,
  readCachedLabel,
  shalomLabelPdf,
  shalomVoucherPdf,
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

  it("el rótulo se queda en la raíz: mover lo ya guardado sería tirarlo", () => {
    // Hay cientos de rótulos cacheados en `{ose}.pdf`. Cambiar su ruta solo para
    // que hiciera juego con el ticket los invalidaría todos, y cada uno cuesta
    // 45 s de volver a bajar.
    expect(labelPath(7, "label")).toBe("7.pdf");
    expect(labelPath(7, "voucher")).toBe("voucher/7.pdf");
    // Y los dos documentos de la MISMA guía no se pisan.
    expect(labelPath(7, "label")).not.toBe(labelPath(7, "voucher"));
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

describe("pedir el ticket del mostrador", () => {
  // El «Ticket Shalom» es OTRO documento que el rótulo: el rótulo es apaisado y
  // se pega en la caja, el ticket es el recibo de tira del mostrador. Estuvo
  // meses apuntado bajo `/v1/tracking/{ose}/voucher` —404 siempre— cuando cuelga
  // de `/v1/orders`, hermana del rótulo.
  it("usa el cliente de voucher, no el de rótulo", async () => {
    const { admin, uploads } = fakeAdmin();
    const client = {
      voucher: vi.fn(async () => PDF.buffer as ArrayBuffer),
      label: vi.fn(async () => PDF.buffer as ArrayBuffer),
    };
    const out = await shalomVoucherPdf(admin, "st", STORE, 7, client);
    expect(client.voucher).toHaveBeenCalledWith(7);
    expect(client.label).not.toHaveBeenCalled();
    expect(uploads).toEqual([{ path: "voucher/7.pdf", bytes: out }]);
  });

  it("se cachea aparte del rótulo: un ticket guardado no sirve de rótulo", async () => {
    // `stored` responde a CUALQUIER ruta, así que si el ticket compartiera clave
    // con el rótulo esta prueba no distinguiría nada. Lo que se comprueba es la
    // ruta de subida, que es donde está la separación.
    const { admin, uploads } = fakeAdmin();
    const client = {
      voucher: vi.fn(async () => PDF.buffer as ArrayBuffer),
      label: vi.fn(async () => PDF.buffer as ArrayBuffer),
    };
    await shalomLabelPdf(admin, "st", STORE, 7, client);
    await shalomVoucherPdf(admin, "st", STORE, 7, client);
    expect(uploads.map((u) => u.path)).toEqual(["7.pdf", "voucher/7.pdf"]);
  });

  it("con caché NO llama a Shalom, igual que el rótulo", async () => {
    const { admin } = fakeAdmin({ stored: PDF });
    const client = { voucher: vi.fn(async () => PDF.buffer as ArrayBuffer) };
    expect(await shalomVoucherPdf(admin, "st", STORE, 7, client)).toEqual(PDF);
    expect(client.voucher).not.toHaveBeenCalled();
  });

  it("si Shalom falla, el error sube", async () => {
    const { admin } = fakeAdmin();
    const client = {
      voucher: vi.fn(async () => {
        throw new Error("No hubo respuesta de Shalom");
      }),
    };
    await expect(shalomVoucherPdf(admin, "st", STORE, 7, client)).rejects.toThrow(/Shalom/);
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
