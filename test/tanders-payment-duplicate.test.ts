// Comprobante de pago reusado: el mismo dinero no cobra dos pedidos.
//
// La regla pura vive en payment-check.ts y se prueba allí. Acá se prueba lo que
// esa regla NO puede saber sola: que el barrido busque de verdad el nº de
// operación en las comprobaciones anteriores, que excluya la propia guía —que
// se relee en cada pasada mientras siga pendiente, y si no se excluyera se
// acusaría a sí misma—, y que el aviso salga solo cuando hay algo que avisar.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDuplicateAlert } from "@/lib/tanders/duplicate-alert";

const h = vi.hoisted(() => ({
  avisos: [] as unknown[][],
  checksPrevios: [] as { shipment_id: string }[],
  /** Estado de la guía con la que se choca. Por defecto, una que no se cobró. */
  chocada: { payment_check_state: null, delivery_status: "en_ruta" } as Record<string, unknown>,
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async () => {}) }));
vi.mock("@/lib/tanders/duplicate-alert", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/duplicate-alert")>()),
  alertDuplicatePayments: vi.fn(async (...args: unknown[]) => {
    h.avisos.push(args);
    return { avisadas: 0 };
  }),
}));
vi.mock("@/lib/tanders/payment-vision", () => ({
  readTandersPayment: vi.fn(async () => ({
    isPaymentProof: true,
    method: "yape" as const,
    recipientName: "Grupo GF SAC",
    amount: 129,
    // Con guiones a propósito: al guardarse y compararse tiene que colisionar
    // con el "86480816" que ya está en la base.
    operationNumber: "864-808-16",
    ok: true,
    model: "m",
  })),
}));
vi.mock("@/lib/tanders/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/client")>()),
  TandersClient: class {
    async evidences(guia: string) {
      return {
        orderNumber: guia,
        payments: [
          {
            amount: 129,
            entity: "YAPE",
            paymentDocument: "https://x/o/files_payment%2Fg%2Fa.jpg?alt=media",
          },
        ],
      };
    }
  },
}));
vi.mock("@/lib/tanders/sweep-failures", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/sweep-failures")>()),
  pace: async () => {},
}));

const { sweepTandersPayments } = await import("@/lib/tanders/payment-sweep");
const { alertDuplicatePayments } = await import("@/lib/tanders/duplicate-alert");

const CANDIDATA = {
  id: "id-1",
  store_id: "tienda",
  guide_code: "TANDER1",
  tanders_order_id: "oid-1",
  order_id: "ped-1",
  order_name: "#AUR176448",
  payment_check_state: null,
  tanders_raw: { collectionAmount: 129 },
};

function adminFalso() {
  const visto = {
    neq: [] as unknown[][],
    buscadoPor: [] as unknown[][],
    insertado: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
  };
  function cadena(filas: unknown[]) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "or", "limit"]) q[m] = () => q;
    q.order = () => q;
    q.neq = (...a: unknown[]) => {
      visto.neq.push(a);
      return q;
    };
    q.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: filas, error: null }).then(ok);
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
          select: (...a: unknown[]) => {
            visto.buscadoPor.push(a);
            return cadena(h.checksPrevios);
          },
          insert: async (fila: Record<string, unknown>) => {
            visto.insertado.push(fila);
            return { error: null };
          },
        };
      }
      return {
        // La consulta de candidatas y la de guías chocadas piden columnas
        // distintas: es lo que las distingue en el doble.
        select: (cols?: string) =>
          cols?.includes("payment_check_state,delivery_status")
            ? cadena([{ id: "id-9", order_name: "#KP131846", guide_code: "TANDER9", store_id: "tienda", order_id: "ped-9", ...h.chocada }])
            : cadena([CANDIDATA]),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, id: string) => {
            visto.updates.push({ ...patch, __id: id });
            return { error: null };
          },
          in: async (_c: string, ids: string[]) => {
            visto.updates.push({ ...patch, __id: ids.join(",") });
            return { error: null };
          },
        }),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, visto };
}

beforeEach(() => {
  h.avisos.length = 0;
  h.checksPrevios.length = 0;
  h.chocada = { payment_check_state: null, delivery_status: "en_ruta" };
  vi.mocked(alertDuplicatePayments).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      headers: { get: () => "image/jpeg" },
    })),
  );
});

describe("comprobante de pago reusado", () => {
  it("no da por cobrada una guía cuyo comprobante ya estaba en otra", () => {
    h.checksPrevios.push({ shipment_id: "id-9" });
    return sweepTandersPayments(adminFalso().admin).then((r) => {
      expect(r.rechazado).toBe(1);
      expect(r.validado).toBe(0);
      // Y no se marca entregado: es el bloqueo que de verdad protege la plata.
      expect(r.entregado).toBe(0);
      expect(r.duplicados).toEqual([
        {
          guia: "TANDER1",
          pedido: "#AUR176448",
          operacion: "86480816",
          otras: ["#KP131846"],
          desandadas: [],
          monto: 129,
          storeId: "tienda",
        },
      ]);
    });
  });

  it("la guía que YA se había cobrado con ese comprobante deja de estar cobrada", async () => {
    // El caso real del 10-09-2026: #KP125070 y #KP124793 cayeron en la misma
    // pasada con el yape de S/ 198. Bloquear solo a la segunda dejaría cobrada
    // justo la que nadie va a revisar, y cuál fue cuál lo decidió el orden de
    // la cola. `entregado` significa «entregado Y cobrado» (§9.4): si el cobro
    // deja de estar probado, vuelve a `en_ruta`, que es lo que el courier sí
    // acredita.
    h.checksPrevios.push({ shipment_id: "id-9" });
    h.chocada = { payment_check_state: "validado", delivery_status: "entregado" };
    const { admin, visto } = adminFalso();

    const r = await sweepTandersPayments(admin);
    expect(r.duplicados[0]?.desandadas).toEqual(["#KP131846"]);
    const desandada = visto.updates.find((u) => u.__id === "id-9");
    expect(desandada).toMatchObject({
      payment_check_state: "rechazado",
      delivery_status: "en_ruta",
    });
    // Y queda constancia de POR QUÉ, para que el revisor no adivine.
    expect(visto.insertado.some((f) => f.shipment_id === "id-9")).toBe(true);
  });

  it("no deshace lo que un administrador ya revisó a mano", async () => {
    // `revisado` es una decisión humana explícita; un barrido no la tumba.
    h.checksPrevios.push({ shipment_id: "id-9" });
    h.chocada = { payment_check_state: "revisado", delivery_status: "entregado" };
    const { admin, visto } = adminFalso();

    const r = await sweepTandersPayments(admin);
    expect(r.duplicados[0]?.desandadas).toEqual([]);
    expect(visto.updates.find((u) => u.__id === "id-9")).toBeUndefined();
  });

  it("busca el nº normalizado y excluye la propia guía", async () => {
    // Sin la exclusión, una guía que se relee se acusaría a sí misma de
    // duplicar su propio comprobante y nunca se cobraría.
    const { admin, visto } = adminFalso();
    await sweepTandersPayments(admin);
    expect(visto.neq).toContainEqual(["shipment_id", "id-1"]);
    // Guardado normalizado, no "864-808-16".
    expect(visto.insertado[0]?.operation_number).toBe("86480816");
  });

  it("sin choque, cobra normal y no avisa a nadie", async () => {
    const { admin } = adminFalso();
    const r = await sweepTandersPayments(admin);
    expect(r.validado).toBe(1);
    expect(r.duplicados).toEqual([]);
    expect(vi.mocked(alertDuplicatePayments).mock.calls[0]?.[1]).toEqual([]);
  });

  it("en seco detecta el duplicado pero no escribe ni avisa", async () => {
    h.checksPrevios.push({ shipment_id: "id-9" });
    const { admin, visto } = adminFalso();
    const r = await sweepTandersPayments(admin, { dry: true });
    expect(r.duplicados).toHaveLength(1);
    expect(visto.insertado).toEqual([]);
    expect(visto.updates).toEqual([]);
    expect(alertDuplicatePayments).not.toHaveBeenCalled();
  });
});

describe("formatDuplicateAlert", () => {
  it("dice el pedido, el monto, la operación y con quién choca", () => {
    const texto = formatDuplicateAlert("Aurela", [
      {
        guia: "TANDER1",
        pedido: "#AUR176448",
        operacion: "86480816",
        otras: ["#KP131846"],
        desandadas: [],
        monto: 129,
        storeId: "t",
      },
    ]);
    expect(texto).toContain("#AUR176448");
    expect(texto).toContain("S/ 129.00");
    expect(texto).toContain("86480816");
    expect(texto).toContain("#KP131846");
  });

  it("destaca la que se había dado por cobrada: es lo urgente", () => {
    const texto = formatDuplicateAlert("Aurela", [
      {
        guia: "TANDER1",
        pedido: "#KP124793",
        operacion: "14881571",
        otras: ["#KP125070"],
        desandadas: ["#KP125070"],
        monto: 198,
        storeId: "t",
      },
    ]);
    expect(texto).toContain("#KP125070 estaba dado por COBRADO");
  });

  it("escapa el HTML del nombre de la tienda", () => {
    // El texto va a Telegram en modo HTML: un nombre con < rompería el mensaje
    // entero y el aviso no llegaría.
    const texto = formatDuplicateAlert("A <b>&", []);
    expect(texto).toContain("A &lt;b&gt;&amp;");
  });
});
