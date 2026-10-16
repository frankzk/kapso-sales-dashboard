// El barrido de cobros Tanders: las validadas que se quedaron sin ficha, y el
// veredicto repetido que no deja otra fila.
//
// LOS CASOS (auditoría del 14-10-2026).
//  · 203 guías `entregado` con el cobro `validado` por el lector y sin ficha
//    `cobro_courier` en «Validar pagos» —202 validadas entre el 10 y el
//    12-09-2026, antes de que existiera la cola—. El barrido solo relee las
//    guías vivas, así que nunca volvían: nadie podía firmar su cobro y el
//    pedido no salía de «Pendiente de liquidación».
//  · Cuatro guías con un comprobante repetido dejaban una fila idéntica en
//    `tanders_payment_checks` en cada pasada: 175-189 cada una.
//
// Lo que se fija acá: la ficha se crea con la lectura guardada (sin volver a
// llamar al modelo ni a Tanders), entra a la espera de una persona, no se
// duplica, la consulta va acotada y en seco no se escribe nada; y releer una
// guía y llegar a lo mismo no escribe otra comprobación.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fichaDesdeComprobacion,
  medioSegunTanders,
  mismaComprobacion,
  type ComprobacionGuardada,
} from "@/lib/tanders/payment-sweep-rules";

const h = vi.hoisted(() => ({
  evidences: [] as string[],
  lecturas: 0,
  alertas: [] as unknown[],
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: vi.fn(async () => {}) }));
vi.mock("@/lib/tanders/duplicate-alert", () => ({ alertDuplicatePayments: vi.fn(async () => ({ avisadas: 0 })) }));
vi.mock("@/lib/repeated-voucher-alert", async (orig) => ({
  ...(await orig<typeof import("@/lib/repeated-voucher-alert")>()),
  raiseRepeatedVoucherAlert: vi.fn(async (_admin: unknown, v: unknown) => {
    h.alertas.push(v);
    return { alertId: "a", telegram: false };
  }),
}));
vi.mock("@/lib/tanders/payment-vision", () => ({
  readTandersPayment: vi.fn(async () => {
    h.lecturas += 1;
    return {
      isPaymentProof: true,
      method: "yape",
      toYape: false,
      recipientName: "Grupo GF SAC",
      amount: 149,
      operationNumber: "24447519",
      paidAt: null,
      ok: true,
      model: "m",
    };
  }),
}));
vi.mock("@/lib/tanders/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/client")>()),
  TandersClient: class {
    async evidences(id: string) {
      h.evidences.push(id);
      return {
        orderNumber: id,
        payments: [{ amount: 149, entity: "YAPE", paymentDocument: IMG_VIVA }],
      };
    }
  },
}));
vi.mock("@/lib/tanders/sweep-failures", async (orig) => ({
  ...(await orig<typeof import("@/lib/tanders/sweep-failures")>()),
  pace: async () => {},
}));

const { sweepTandersPayments, MAX_FICHAS_POR_PASADA, MAX_VALIDADAS_POR_PASADA } = await import(
  "@/lib/tanders/payment-sweep"
);

/** La constancia de cada guía: una imagen distinta, para que no choquen entre sí. */
const img = (n: number) =>
  `https://firebasestorage.googleapis.com/v0/b/x/o/files_payment%2F${n}-89yape.png?alt=media&token=t${n}`;
const IMG = img(1);
const IMG_VIVA = "https://firebasestorage.googleapis.com/v0/b/x/o/files_payment%2F149yape.png?alt=media&token=t2";
/** Los bytes que «baja» el fetch de mentira: el propio enlace. */
const bytesDe = (url: string) => new TextEncoder().encode(url);
const SHA = createHash("sha256").update(Buffer.from(bytesDe(IMG))).digest("hex");

// ---------------------------------------------------------------------------
// Una base de mentira que evalúa los filtros de verdad
// ---------------------------------------------------------------------------

type Fila = Record<string, unknown>;
type Db = Record<string, Fila[]>;

interface Consulta {
  tabla: string;
  filtros: unknown[][];
  orden: { col: string; opts: unknown }[];
  limite: number | null;
}

function cumple(fila: Fila, f: unknown[]): boolean {
  const [op, col, a, b] = f as [string, string, unknown, unknown];
  const v = fila[col];
  switch (op) {
    case "eq":
      return v === a;
    case "neq":
      return v !== a;
    case "in":
      return (a as unknown[]).includes(v);
    case "contains":
      return (a as unknown[]).every((x) => ((v as unknown[]) ?? []).includes(x));
    case "not":
      return a === "is" && b === null ? v != null : true;
    default:
      // `or` y compañía: las filas de estas pruebas ya los cumplen.
      return true;
  }
}

function adminFalso(db: Db, opts: { subidasFallan?: number; fallan?: string[] } = {}) {
  let subidasFallan = opts.subidasFallan ?? 0;
  const visto = {
    consultas: [] as Consulta[],
    inserts: [] as { tabla: string; fila: Fila }[],
    updates: [] as { tabla: string; patch: Fila; ids: unknown[] }[],
    subidas: 0,
  };
  const leer = (c: Consulta): Fila[] => {
    let filas = (db[c.tabla] ?? []).filter((f) => c.filtros.every((x) => cumple(f, x)));
    for (const { col, opts } of [...c.orden].reverse()) {
      const asc = (opts as { ascending?: boolean } | undefined)?.ascending !== false;
      filas = [...filas].sort((x, y) => {
        const a = x[col] as string | null;
        const b = y[col] as string | null;
        if (a === b) return 0;
        if (a == null) return -1; // nulls first
        if (b == null) return 1;
        return (a < b ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    return c.limite == null ? filas : filas.slice(0, c.limite);
  };
  const admin = {
    storage: {
      from: () => ({
        upload: async () => {
          if (subidasFallan > 0) {
            subidasFallan -= 1;
            return { error: { message: "bucket caído" } };
          }
          visto.subidas += 1;
          return { error: null };
        },
      }),
    },
    from(tabla: string) {
      return {
        select: () => {
          const c: Consulta = { tabla, filtros: [], orden: [], limite: null };
          visto.consultas.push(c);
          const q: Record<string, unknown> = {};
          for (const m of ["eq", "neq", "in", "or", "not", "contains", "is", "gte", "lte"]) {
            q[m] = (...a: unknown[]) => {
              c.filtros.push([m, ...a]);
              return q;
            };
          }
          q.order = (col: string, opts: unknown) => {
            c.orden.push({ col, opts });
            return q;
          };
          q.limit = (n: number) => {
            c.limite = n;
            return q;
          };
          const falla = (opts.fallan ?? []).includes(tabla);
          q.maybeSingle = async () => ({ data: falla ? null : leer(c)[0] ?? null, error: falla ? { message: "lectura" } : null });
          q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve(falla ? { data: null, error: { message: "lectura" } } : { data: leer(c), error: null }).then(ok, ko);
          return q;
        },
        insert: (fila: Fila) => {
          visto.inserts.push({ tabla, fila });
          (db[tabla] ??= []).push({
            id: `${tabla}-${(db[tabla] ?? []).length + 1}`,
            checked_at: new Date().toISOString(),
            ...fila,
          });
          const res = { error: null };
          return Object.assign(Promise.resolve(res), {
            select: () => ({ single: async () => ({ data: { id: "nuevo" }, error: null }) }),
          });
        },
        // Las escrituras se aplican a la base de mentira: una pasada ve lo
        // que dejó la anterior (el estado, el sello).
        update: (patch: Fila) => ({
          eq: async (c: string, v: unknown) => {
            visto.updates.push({ tabla, patch, ids: [v] });
            for (const f of db[tabla] ?? []) if (f[c] === v) Object.assign(f, patch);
            return { error: null };
          },
          in: async (c: string, v: unknown[]) => {
            visto.updates.push({ tabla, patch, ids: v });
            for (const f of db[tabla] ?? []) if (v.includes(f[c])) Object.assign(f, patch);
            return { error: null };
          },
        }),
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { admin: admin as any, visto };
}

const TIENDA = { id: "tienda", tanders_email: "a@b.c", tanders_password_enc: "x", anthropic_api_key_enc: "k", anthropic_model: "m" };

/** Una guía que el lector validó el 10-09-2026, antes de que existiera la cola. */
function validada(n: number, extra: Fila = {}): Fila {
  return {
    id: `g-${n}`,
    store_id: "tienda",
    courier: "tanders",
    guide_code: `TANDER${n}`,
    tanders_order_id: `oid-${n}`,
    order_id: `ped-${n}`,
    order_name: `#AUR${n}`,
    delivery_status: "entregado",
    payment_check_state: "validado",
    payment_checked_at: "2026-09-10T18:00:00Z",
    ...extra,
  };
}

/** Su lectura guardada en `tanders_payment_checks`. */
function lectura(n: number, extra: Fila = {}): Fila {
  return {
    id: `c-${n}`,
    shipment_id: `g-${n}`,
    store_id: "tienda",
    state: "validado",
    reasons: [],
    image_url: img(n),
    operation_number: `20507${String(n).padStart(3, "0")}`,
    amount: "89.00",
    expected_amount: "89.00",
    recipient_name: "Grupo Gf S.a.c.",
    model: "claude-sonnet-5",
    checked_at: "2026-09-10T18:00:00Z",
    raw: { orderNumber: `TANDER${n}`, payments: [{ amount: 89, entity: "YAPE", paymentDocument: img(n) }] },
    ...extra,
  };
}

function base(guias: Fila[], checks: Fila[], extra: Db = {}): Db {
  return {
    stores: [TIENDA],
    shipments: guias,
    tanders_payment_checks: checks,
    order_payments: [],
    collection_alerts: [],
    orders: [{ id: "ped-otro", name: "#KP999" }],
    ...extra,
  };
}

const fichas = (visto: ReturnType<typeof adminFalso>["visto"]) =>
  visto.inserts.filter((i) => i.tabla === "order_payments").map((i) => i.fila);
const comprobaciones = (visto: ReturnType<typeof adminFalso>["visto"]) =>
  visto.inserts.filter((i) => i.tabla === "tanders_payment_checks").map((i) => i.fila);
const sellados = (visto: ReturnType<typeof adminFalso>["visto"]) =>
  visto.updates.filter((u) => "payment_checked_at" in u.patch).flatMap((u) => u.ids);

beforeEach(() => {
  h.evidences = [];
  h.lecturas = 0;
  h.alertas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytesDe(url).buffer,
      headers: { get: () => "image/png" },
    })),
  );
});

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("mismaComprobacion: cuándo una relectura es un hecho nuevo", () => {
  const ultima = {
    state: "rechazado",
    reasons: ["monto_distinto", "operacion_duplicada"],
    image_url: IMG,
    operation_number: "24447519",
    amount: "149.00",
  };

  it("mismo veredicto sobre el mismo comprobante: no es nuevo", () => {
    // La base devuelve el monto como texto y los motivos pueden venir en otro orden.
    expect(
      mismaComprobacion(ultima, { ...ultima, reasons: ["operacion_duplicada", "monto_distinto"], amount: 149 }),
    ).toBe(true);
  });

  it("sin fila anterior, cualquier comprobación es nueva", () => {
    expect(mismaComprobacion(null, ultima)).toBe(false);
  });

  it.each([
    ["el estado", { state: "validado" }],
    ["los motivos", { reasons: ["operacion_duplicada"] }],
    ["la imagen", { image_url: IMG_VIVA }],
    ["el nº de operación", { operation_number: "11111111" }],
    ["el monto", { amount: 150 }],
  ])("si cambia %s, es un hecho nuevo", (_q, cambio) => {
    expect(mismaComprobacion(ultima, { ...ultima, ...cambio })).toBe(false);
  });
});

describe("fichaDesdeComprobacion: la ficha con la lectura que ya está guardada", () => {
  it("entra como un cobro validado por el lector, sin hora de pago", () => {
    const f = fichaDesdeComprobacion(lectura(1) as unknown as ComprobacionGuardada);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.imageUrl).toBe(IMG);
    expect(f.verdict).toMatchObject({ state: "validado", reasons: [] });
    expect(f.verdict.summary).toContain("10-09-2026");
    expect(f.reading).toMatchObject({
      isPaymentProof: true,
      method: "yape",
      recipientName: "Grupo Gf S.a.c.",
      amount: 89,
      operationNumber: "20507001",
      // Esa lectura no transcribía la hora: sin ella el estado de cuenta no la
      // cruza y la firma la pone una persona.
      paidAt: null,
      ok: true,
      model: "claude-sonnet-5",
    });
    expect(f.expectedAmount).toBe(89);
  });

  it.each([
    ["sin ninguna lectura guardada", null],
    ["si lo guardado no es «validado»", lectura(1, { state: "rechazado", reasons: ["monto_distinto"] })],
    ["si lo guardado no tiene imagen", lectura(1, { image_url: null })],
  ])("no inventa la ficha %s", (_q, fila) => {
    const f = fichaDesdeComprobacion(fila as unknown as ComprobacionGuardada | null);
    expect(f.ok).toBe(false);
  });

  it("el medio sale de lo que Tanders dice de ESA imagen; lo que no reconoce es «otro»", () => {
    const raw = { payments: [{ entity: "PLIN", paymentDocument: IMG }, { entity: "BBVA", paymentDocument: IMG_VIVA }] };
    expect(medioSegunTanders(raw, IMG)).toBe("plin");
    expect(medioSegunTanders(raw, IMG_VIVA)).toBe("otro");
    expect(medioSegunTanders(raw, "https://x/o/files_payment%2Fotra.png")).toBe("otro");
  });
});

// ---------------------------------------------------------------------------
// El barrido
// ---------------------------------------------------------------------------

describe("barrido: las validadas que se quedaron sin ficha", () => {
  it("les crea la ficha pendiente de revisión, sin volver a leerlas", async () => {
    const { admin, visto } = adminFalso(base([validada(1)], [lectura(1)]));
    const r = await sweepTandersPayments(admin);

    expect(r.sinFicha).toBe(1);
    expect(r.fichasRecuperadas).toBe(1);
    expect(r.aRevision).toBe(1);
    const [ficha] = fichas(visto);
    expect(ficha).toMatchObject({
      order_id: "ped-1",
      kind: "cobro_courier",
      // Como cualquier cobro que el lector dio por bueno: espera a una persona.
      validation_status: "pendiente_revision",
      amount: 89,
      operation_number: "20507001",
      paid_at: null,
      file_sha256: SHA,
    });
    expect(String(ficha!.notes)).toContain("sin volver a leerla");
    // La imagen se guarda en NUESTRO bucket, como en el camino normal.
    expect(visto.subidas).toBe(1);
    // Ni el modelo ni Tanders: el veredicto ya estaba dado.
    expect(h.lecturas).toBe(0);
    expect(h.evidences).toEqual([]);
    // La guía no se toca —ni estado ni cobro—; solo lleva el sello de mirada.
    const parches = visto.updates.filter((u) => u.tabla === "shipments").map((u) => Object.keys(u.patch));
    expect(parches).toEqual([["payment_checked_at"]]);
    expect(sellados(visto)).toEqual(["g-1"]);
    // Y no se escribe otra comprobación: no hubo lectura nueva.
    expect(comprobaciones(visto)).toEqual([]);
  });

  it("no crea una segunda ficha: ni si ya la tenía, ni en la pasada siguiente", async () => {
    const db = base(
      [validada(1), validada(2)],
      [lectura(1), lectura(2)],
      {
        order_payments: [
          { id: "p-2", order_id: "ped-2", kind: "cobro_courier", validation_status: "validado", validated_by: "u" },
        ],
      },
    );
    const { admin, visto } = adminFalso(db);
    const r1 = await sweepTandersPayments(admin);
    expect(r1.sinFicha).toBe(1);
    expect(fichas(visto).map((f) => f.order_id)).toEqual(["ped-1"]);
    // Las dos quedan selladas: la que ya tenía ficha también se miró.
    expect(sellados(visto).sort()).toEqual(["g-1", "g-2"]);

    const r2 = await sweepTandersPayments(admin);
    expect(r2.sinFicha).toBe(0);
    expect(fichas(visto)).toHaveLength(1);
  });

  it("la consulta va acotada: tope, cola ordenada, y lo que no cupo va primero la próxima", async () => {
    const n = MAX_FICHAS_POR_PASADA + 3;
    const guias = Array.from({ length: n }, (_, i) => validada(i + 1, { payment_checked_at: `2026-09-10T18:${String(i).padStart(2, "0")}:00Z` }));
    const { admin, visto } = adminFalso(base(guias, guias.map((_, i) => lectura(i + 1))));
    const r = await sweepTandersPayments(admin);

    const consulta = visto.consultas.find(
      (c) => c.tabla === "shipments" && c.filtros.some((f) => f[0] === "eq" && f[1] === "delivery_status" && f[2] === "entregado"),
    )!;
    expect(consulta.limite).toBe(MAX_VALIDADAS_POR_PASADA);
    expect(consulta.orden).toEqual([{ col: "payment_checked_at", opts: { ascending: true, nullsFirst: true } }]);
    expect(consulta.filtros).toContainEqual(["eq", "payment_check_state", "validado"]);

    expect(r.fichasRecuperadas).toBe(MAX_FICHAS_POR_PASADA);
    // Las tres que no cupieron no llevan sello: encabezan la siguiente pasada.
    expect(sellados(visto)).toHaveLength(MAX_FICHAS_POR_PASADA);
    expect(sellados(visto)).not.toContain(`g-${n}`);
  });

  it("en seco las cuenta pero no escribe nada", async () => {
    const { admin, visto } = adminFalso(base([validada(1)], [lectura(1)]));
    const r = await sweepTandersPayments(admin, { dry: true });
    expect(r.sinFicha).toBe(1);
    expect(r.fichasRecuperadas).toBe(0);
    expect(r.fichasBloqueadas).toBe(0);
    expect(visto.inserts).toEqual([]);
    expect(visto.updates).toEqual([]);
    expect(visto.subidas).toBe(0);
  });

  it("sin una lectura validada guardada no inventa la ficha: lo dice", async () => {
    const { admin, visto } = adminFalso(
      base([validada(1)], [lectura(1, { state: "rechazado", reasons: ["monto_distinto"] })]),
    );
    const r = await sweepTandersPayments(admin);
    expect(fichas(visto)).toEqual([]);
    expect(r.errores).toBe(1);
    expect(r.fallos[0]?.mensaje).toContain("no es «validado»");
    // Se mira igual: sin sello se clavaría al frente de la cola.
    expect(sellados(visto)).toEqual(["g-1"]);
  });

  it("si la misma imagen ya está en otro pedido, no entra a la cola y avisa una sola vez", async () => {
    const otro = {
      id: "p-otro",
      order_id: "ped-otro",
      kind: "cobro_courier",
      amount: 89,
      operation_number: "99999999",
      paid_at: null,
      payer_name: null,
      payer_phone: null,
      file_sha256: SHA,
      validation_status: "validado",
    };
    const { admin, visto } = adminFalso(base([validada(1)], [lectura(1)], { order_payments: [otro] }));
    const r = await sweepTandersPayments(admin);
    expect(r.fichasRecuperadas).toBe(0);
    expect(r.fichasBloqueadas).toBe(1);
    expect(fichas(visto)).toEqual([]);
    expect(h.alertas).toHaveLength(1);
    expect(h.alertas[0]).toMatchObject({ orderName: "#AUR1", alsoIn: ["#KP999"], source: "cobro_courier" });

    // Cerrada con «Ya lo revisé», la vuelta siguiente de la cola no la reabre.
    h.alertas = [];
    const db2 = base([validada(1)], [lectura(1)], {
      order_payments: [otro],
      collection_alerts: [{ id: "a1", kind: "comprobante_repetido", dedupe_key: `sha:${SHA}`, resolved_at: "2026-10-15T00:00:00Z" }],
    });
    await sweepTandersPayments(adminFalso(db2).admin);
    expect(h.alertas).toEqual([]);
  });

  it("un comprobante que ya tiene alerta de repetido no entra a la cola, aunque nada choque", async () => {
    // El Lemon de S/ 89 de #KP124940, #KP126075, #KP126468 y #KP126871: los
    // cuatro validados sin ficha y sin ningún pago registrado con el que
    // chocar. Sin esto, el primero entraría a «Validar pagos» como un cobro de
    // rutina, con la alerta cerrada con «estamos consultando».
    const db = base([validada(1)], [lectura(1, { operation_number: null })], {
      collection_alerts: [
        { id: "a1", kind: "comprobante_repetido", dedupe_key: `sha:${SHA}`, status: "atendida", resolution: "estamos consultando" },
      ],
    });
    const { admin, visto } = adminFalso(db);
    const r = await sweepTandersPayments(admin);
    expect(r.sinFicha).toBe(1);
    expect(r.fichasBloqueadas).toBe(1);
    expect(r.fichasRecuperadas).toBe(0);
    expect(fichas(visto)).toEqual([]);
    expect(visto.subidas).toBe(0);
    expect(h.alertas).toEqual([]);
    // Se mira igual: vuelve a la cola por detrás.
    expect(sellados(visto)).toEqual(["g-1"]);
  });

  it("también por el nº de operación, si la alerta salió por él", async () => {
    const db = base([validada(1)], [lectura(1)], {
      collection_alerts: [{ id: "a1", kind: "comprobante_repetido", dedupe_key: "op:20507001" }],
    });
    const { admin, visto } = adminFalso(db);
    const r = await sweepTandersPayments(admin);
    expect(r.fichasBloqueadas).toBe(1);
    expect(fichas(visto)).toEqual([]);
  });

  it("un pedido anulado en Shopify no recibe ficha: se cuenta aparte, no es un error y se sella", async () => {
    // #KP131617: anulado en Shopify el 08-09, validado por el lector el 11-09.
    // Firmar su cobro en «Validar pagos» lo cerraría como venta cobrada
    // (MOM §9.4, §30.3 regla 3).
    const db = base([validada(1, { order_name: "#KP131617" }), validada(2)], [lectura(1), lectura(2)], {
      orders: [
        { id: "ped-1", name: "#KP131617", cancelled_at: "2026-09-08T15:00:00Z" },
        { id: "ped-2", name: "#AUR2", cancelled_at: null },
      ],
    });
    const { admin, visto } = adminFalso(db);
    const r = await sweepTandersPayments(admin);
    expect(fichas(visto).map((f) => f.order_id)).toEqual(["ped-2"]);
    expect(r.fichasAnuladas).toBe(1);
    expect(r.anuladas).toEqual(["#KP131617"]);
    expect(r.sinFicha).toBe(1);
    expect(r.errores).toBe(0);
    // Se mira igual: sin sello se clavaría al frente de la cola.
    expect(sellados(visto).sort()).toEqual(["g-1", "g-2"]);
  });

  it("si no se puede leer la anulación, no crea ninguna ficha: «no lo sé» no es «no está anulado»", async () => {
    const { admin, visto } = adminFalso(base([validada(1)], [lectura(1)]), { fallan: ["orders"] });
    const r = await sweepTandersPayments(admin);
    expect(fichas(visto)).toEqual([]);
    expect(r.errores).toBe(1);
    expect(r.fallos[0]?.mensaje).toContain("anulado en Shopify");
  });

  it("la guía que el barrido validó y cuya ficha falló va primera en la pasada siguiente", async () => {
    // Una guía en ruta que el lector valida en esta pasada, y 130 validadas
    // que ya tienen ficha y llevan más tiempo sin mirarse. Antes, la que falló
    // recibía el sello de ahora y esperaba detrás de todas (575 el 16-10-2026):
    // una vuelta entera de la cola.
    const viva: Fila = {
      id: "g-1",
      store_id: "tienda",
      courier: "tanders",
      guide_code: "TANDER1",
      tanders_order_id: "oid-1",
      order_id: "ped-1",
      order_name: "#AUR1",
      delivery_status: "en_ruta",
      payment_check_state: null,
      payment_checked_at: "2026-10-16T10:00:00Z",
      tanders_raw: { collectionAmount: 149 },
    };
    const viejas = Array.from({ length: 130 }, (_, i) =>
      validada(i + 100, { payment_checked_at: `2026-09-${String(10 + (i % 18)).padStart(2, "0")}T18:00:00Z` }),
    );
    const db = base([viva, ...viejas], [], {
      order_payments: viejas.map((g, i) => ({
        id: `p-${i}`,
        order_id: g.order_id,
        kind: "cobro_courier",
        validation_status: "validado",
        validated_by: "u",
      })),
    });
    // La primera subida al bucket falla: la ficha no se crea.
    const { admin, visto } = adminFalso(db, { subidasFallan: 1 });

    const r1 = await sweepTandersPayments(admin);
    expect(r1.validado).toBe(1);
    expect(r1.errores).toBe(1);
    expect(fichas(visto)).toEqual([]);
    // Quedó entregada y validada, sin sello: no se reintenta en la misma pasada.
    expect(db.shipments!.find((g) => g.id === "g-1")).toMatchObject({
      delivery_status: "entregado",
      payment_check_state: "validado",
      payment_checked_at: null,
    });

    const r2 = await sweepTandersPayments(admin);
    expect(r2.fichasRecuperadas).toBe(1);
    expect(fichas(visto).map((f) => f.order_id)).toEqual(["ped-1"]);
    // Sin volver a leer la constancia: la lectura de la pasada anterior basta.
    expect(h.lecturas).toBe(1);
  });
});

describe("barrido: el mismo veredicto no deja otra fila", () => {
  /** Una guía en ruta cuyo comprobante ya estaba en otra guía. */
  function repetida(previa: Fila): Db {
    return base(
      [
        {
          id: "g-1",
          store_id: "tienda",
          courier: "tanders",
          guide_code: "TANDER1",
          tanders_order_id: "oid-1",
          order_id: "ped-1",
          order_name: "#KP126075",
          delivery_status: "en_ruta",
          payment_check_state: "rechazado",
          payment_checked_at: "2026-10-15T22:00:00Z",
          tanders_raw: { collectionAmount: 89 },
        },
        // Fuera de las dos colas: solo está para que el nº choque con ella.
        { id: "g-9", store_id: "tienda", courier: "tanders", guide_code: "TANDER9", order_name: "#KP124940", delivery_status: "anulado", payment_check_state: "rechazado", order_id: "ped-9" },
      ],
      [
        // La otra guía donde ya estaba el mismo nº de operación.
        { id: "c-9", shipment_id: "g-9", state: "rechazado", reasons: ["operacion_duplicada"], operation_number: "24447519", checked_at: "2026-09-11T00:00:00Z" },
        { id: "c-1", shipment_id: "g-1", checked_at: "2026-10-15T22:00:00Z", ...previa },
      ],
    );
  }

  it("releer el comprobante repetido y llegar a lo mismo no escribe otra comprobación", async () => {
    const { admin, visto } = adminFalso(
      repetida({
        state: "rechazado",
        reasons: ["monto_distinto", "operacion_duplicada"],
        image_url: IMG_VIVA,
        operation_number: "24447519",
        amount: "149.00",
      }),
    );
    const r = await sweepTandersPayments(admin);
    expect(r.rechazado).toBe(1);
    expect(comprobaciones(visto)).toEqual([]);
    // El bloqueo se mantiene y la guía se sella igual.
    expect(sellados(visto)).toContain("g-1");
  });

  it("si el veredicto cambió, sí la escribe", async () => {
    const { admin, visto } = adminFalso(
      repetida({ state: "pendiente", reasons: [], image_url: IMG_VIVA, operation_number: null, amount: null }),
    );
    await sweepTandersPayments(admin);
    expect(comprobaciones(visto)).toHaveLength(1);
    expect(comprobaciones(visto)[0]).toMatchObject({ shipment_id: "g-1", state: "rechazado" });
  });
});
