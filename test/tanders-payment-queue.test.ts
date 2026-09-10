// La COLA del barrido de cobros Tanders.
//
// EL CASO. El 10-09-2026 el barrido ya validaba cobros de verdad, pero solo de
// 60 guías: había 238 candidatas y la consulta cortaba en 60 SIN ORDEN, así que
// PostgREST elegía cuáles y elegía las mismas. El pedido #AUR176448 llevaba un
// día entregado, con su Yape de S/ 129 verificado, y no entraba en el lote —ni
// iba a entrar nunca—. No era atraso: era hambre.
//
// Lo que se fija acá es lo que impide que vuelva: que la cola tenga un orden y
// que TODA guía mirada quede sellada, también la que no dio veredicto. Sin lo
// segundo, una guía en ruta (que nunca escribe comprobación) se clava al frente
// de la cola para siempre y vuelve el mismo problema con otra cara.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TandersApiError } from "@/lib/tanders/types";

const h = vi.hoisted(() => ({
  respuestas: new Map<string, unknown>(),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async () => {}) }));
vi.mock("@/lib/tanders/payment-vision", () => ({
  readTandersPayment: vi.fn(async () => ({
    isPaymentProof: true,
    method: "yape" as const,
    recipientName: "Grupo GF SAC",
    amount: 129,
    operationNumber: "1",
    ok: true,
    model: "m",
  })),
}));
vi.mock("@/lib/tanders/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/client")>()),
  TandersClient: class {
    async evidences(id: string) {
      const r = h.respuestas.get(id);
      if (r instanceof Error) throw r;
      return r;
    }
  },
}));
// Sin pausa: acá se prueba el orden, no el ritmo.
vi.mock("@/lib/tanders/sweep-failures", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/sweep-failures")>()),
  pace: async () => {},
}));

const { sweepTandersPayments } = await import("@/lib/tanders/payment-sweep");

/** Guía con constancia de pago buena. */
function conPago(guia: string) {
  return {
    orderNumber: guia,
    payments: [
      {
        amount: 129,
        entity: "YAPE",
        status: "VERIFIED",
        paymentDocument: `https://x/o/files_payment%2F${guia}%2Fa.jpg?alt=media`,
      },
    ],
  };
}

function fila(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${n}`,
    store_id: "tienda",
    guide_code: `TANDER${n}`,
    tanders_order_id: `oid-${n}`,
    order_id: `ped-${n}`,
    order_name: `#AUR${n}`,
    payment_check_state: null,
    tanders_raw: { collectionAmount: 129 },
    ...extra,
  };
}

function adminFalso(candidatas: unknown[]) {
  const visto = {
    orden: [] as { col: string; opts: unknown }[],
    updates: [] as { patch: Record<string, unknown>; ids: string[] }[],
    inserts: 0,
  };
  function consulta() {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "limit"]) q[m] = () => q;
    q.order = (col: string, opts: unknown) => {
      visto.orden.push({ col, opts });
      return q;
    };
    q.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: candidatas, error: null }).then(ok);
    return q;
  }
  const admin = {
    from(tabla: string) {
      if (tabla === "stores") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  tanders_email: "a@b.c",
                  tanders_password_enc: "x",
                  anthropic_api_key_enc: "k",
                  anthropic_model: "m",
                },
              }),
            }),
          }),
        };
      }
      if (tabla === "tanders_payment_checks") {
        return {
          insert: async () => {
            visto.inserts += 1;
            return { error: null };
          },
        };
      }
      return {
        select: () => consulta(),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, v: string) => {
            visto.updates.push({ patch, ids: [v] });
            return { error: null };
          },
          in: async (_c: string, v: string[]) => {
            visto.updates.push({ patch, ids: v });
            return { error: null };
          },
        }),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, visto };
}

/** Los ids que esta pasada dejó sellados como «mirada». */
function sellados(visto: ReturnType<typeof adminFalso>["visto"]): string[] {
  return visto.updates.filter((u) => "payment_checked_at" in u.patch).flatMap((u) => u.ids);
}

beforeEach(() => {
  h.respuestas.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => "image/jpeg" },
    })),
  );
});

describe("cola del barrido de cobros", () => {
  it("pide primero las que hace más tiempo que no se miran", async () => {
    // Sin esto la consulta corta en 60 de 238 y el resto no se mira jamás.
    const { admin, visto } = adminFalso([]);
    await sweepTandersPayments(admin);
    expect(visto.orden).toEqual([
      { col: "payment_checked_at", opts: { ascending: true, nullsFirst: true } },
    ]);
  });

  it("sella TODA guía mirada, den o no veredicto", async () => {
    // La de en ruta es la importante: no escribe comprobación, así que sin
    // sello volvería a encabezar la cola en cada pasada.
    h.respuestas.set("oid-1", conPago("TANDER1"));
    h.respuestas.set(
      "oid-2",
      new TandersApiError("Order is not yet delivered", 400, null, "GET", "/x"),
    );
    h.respuestas.set("oid-3", { orderNumber: "TANDER3", payments: [] });
    const { admin, visto } = adminFalso([fila(1), fila(2), fila(3)]);

    const r = await sweepTandersPayments(admin);
    expect(r.validado).toBe(1);
    expect(r.enCurso).toBe(2);
    expect(sellados(visto).sort()).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("la guía que se topó con el 429 NO se sella: no se la llegó a preguntar", async () => {
    h.respuestas.set("oid-1", conPago("TANDER1"));
    h.respuestas.set("oid-2", new TandersApiError("Too Many Requests", 429));
    const { admin, visto } = adminFalso([fila(1), fila(2), fila(3)]);

    const r = await sweepTandersPayments(admin);
    expect(r.detenido).toBe(true);
    // Solo la primera. La del 429 y la que quedó detrás van primero la próxima.
    expect(sellados(visto)).toEqual(["id-1"]);
  });

  it("sella también lo que falló de forma definitiva", async () => {
    // Una guía sin id interno fallaría igual mañana; dejarla sin sello la clava
    // al frente de la cola y se come un sitio en cada pasada.
    const { admin, visto } = adminFalso([fila(1, { tanders_order_id: null })]);
    const r = await sweepTandersPayments(admin);
    expect(r.errores).toBe(1);
    expect(sellados(visto)).toEqual(["id-1"]);
  });

  it("en seco no escribe nada: ni veredicto, ni sello", async () => {
    h.respuestas.set("oid-1", conPago("TANDER1"));
    const { admin, visto } = adminFalso([fila(1)]);

    const r = await sweepTandersPayments(admin, { dry: true });
    expect(r.validado).toBe(1);
    expect(visto.updates).toEqual([]);
    expect(visto.inserts).toBe(0);
  });
});
