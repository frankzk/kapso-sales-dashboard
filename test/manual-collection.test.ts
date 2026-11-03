// Cargar a mano la constancia de cobro de una guía Tanders (03-11-2026): la que
// llegó por WhatsApp y no está en Tanders. Se busca por nuestro código de pedido
// o por la guía de Tanders.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectionGate, parseCollectionQuery, type CollectionTarget } from "@/lib/tanders/manual-collection";
import { registerCourierCollection } from "@/lib/tanders/collection-payment";

const guia = (over: Partial<CollectionTarget> = {}): CollectionTarget => ({
  shipmentId: "s1",
  orderId: "o1",
  orderName: "#KP126057",
  storeName: "Kenku Peru",
  guideCode: "TANDER17857936844493151",
  deliveryStatus: "en_ruta",
  reportedStatus: "DELIVERED",
  expectedAmount: 99,
  cancelledAt: null,
  livePayment: null,
  ...over,
});

describe("parseCollectionQuery: se busca de las dos maneras", () => {
  it("por la guía de Tanders, en cualquier caja", () => {
    expect(parseCollectionQuery("TANDER17852702234184882")).toEqual({ kind: "guia", guideCode: "TANDER17852702234184882" });
    expect(parseCollectionQuery(" tander17852702234184882 ")).toEqual({ kind: "guia", guideCode: "TANDER17852702234184882" });
  });

  it("por nuestro código de pedido, con o sin #", () => {
    expect(parseCollectionQuery("#KP124940")).toEqual({ kind: "pedido", orderName: "#KP124940" });
    expect(parseCollectionQuery("kp124940")).toEqual({ kind: "pedido", orderName: "#KP124940" });
    expect(parseCollectionQuery("AUR174710")).toEqual({ kind: "pedido", orderName: "#AUR174710" });
  });

  it("lo que no es ninguna de las dos no se adivina", () => {
    expect(parseCollectionQuery("")).toBeNull();
    expect(parseCollectionQuery("Julio Julio")).toBeNull();
    expect(parseCollectionQuery("984780336")).toBeNull();
  });
});

describe("collectionGate", () => {
  it("una guía entregada sin constancia se puede cargar sin más", () => {
    expect(collectionGate(guia())).toEqual({ blockers: [], warnings: [], needsCancelConfirmation: false });
  });

  it("si el pedido ya tiene una constancia viva, no entra otra: sería el mismo dinero dos veces", () => {
    const g = collectionGate(guia({ livePayment: { status: "pendiente_revision", amount: 99 } }));
    expect(g.blockers[0]).toContain("ya tiene una constancia de cobro");
  });

  it("una guía anulada no salió a la calle: no tiene cobro", () => {
    expect(collectionGate(guia({ deliveryStatus: "anulado" })).blockers[0]).toContain("anulada");
  });

  it("si Tanders aún no la da por entregada, avisa pero no frena", () => {
    const g = collectionGate(guia({ reportedStatus: "IN_TRANSIT" }));
    expect(g.blockers).toEqual([]);
    expect(g.warnings[0]).toContain("IN_TRANSIT");
  });

  it("un pedido anulado en Shopify se carga solo confirmándolo expresamente (#KP130888)", () => {
    expect(collectionGate(guia({ cancelledAt: "2026-10-09T16:12:54Z" })).needsCancelConfirmation).toBe(true);
  });
});

describe("registerCourierCollection con una constancia subida a mano", () => {
  function fakeAdmin() {
    const inserted: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    const q = () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        then: (ok: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
        insert: (row: Record<string, unknown>) => (inserted.push(row), Promise.resolve({ error: null })),
      };
      return chain;
    };
    return {
      inserted,
      uploads,
      admin: {
        from: q,
        storage: { from: () => ({ upload: async (path: string) => (uploads.push(path), { error: null }) }) },
      } as never,
    };
  }

  it("no la vuelve a subir, dice quién la cargó y de dónde vino", async () => {
    const f = fakeAdmin();
    const out = await registerCourierCollection(f.admin, {
      storeId: "kenku",
      orderId: "o1",
      guideCode: "TANDER17857936844493151",
      imageUrl: null,
      imageBytes: new TextEncoder().encode("yape-whatsapp").buffer as ArrayBuffer,
      mediaType: "image/jpeg",
      reading: { ok: true, isPaymentProof: true, method: "yape", amount: 99, operationNumber: "12345678", paidAt: null } as never,
      verdict: { state: "validado", reasons: [], summary: "ok" },
      expectedAmount: 99,
      manual: { storedPath: "kenku/o1/manual-TANDER1-1.jpg", registeredBy: "user-1" },
    });
    expect(out).toEqual({ registered: true, status: "pendiente_revision" });
    expect(f.uploads).toEqual([]);
    expect(f.inserted[0]).toMatchObject({
      kind: "cobro_courier",
      file_path: "kenku/o1/manual-TANDER1-1.jpg",
      registered_by: "user-1",
      vision: { source: "subida_manual", guide_code: "TANDER17857936844493151" },
    });
  });
});

describe("las piezas", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("la acción pasa por el mismo puente que el barrido y avisa del comprobante repetido", () => {
    const actions = read("app/dashboard/pagos/constancia/actions.ts");
    expect(actions).toContain("registerCourierCollection(admin, {");
    expect(actions).toContain("manual: { storedPath: input.path, registeredBy: auth.userId }");
    expect(actions).toContain('source: "subida_manual"');
    // Los pares con un solo Yape solo chocan en las lecturas de Tanders.
    expect(actions).toContain('.from("tanders_payment_checks")');
    expect(actions).toContain('perms.can("shalom.register_payment")');
    expect(actions).toContain("confirmCancelled");
  });

  it("vive como pestaña de «Validar pagos» y se pega con Ctrl+V", () => {
    expect(read("components/payment-review-tabs.tsx")).toContain('href: "/dashboard/pagos/constancia"');
    expect(read("components/manual-collection-upload.tsx")).toContain('window.addEventListener("paste", onPaste)');
  });
});
