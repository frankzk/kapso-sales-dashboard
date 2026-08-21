import { describe, expect, it, vi } from "vitest";

// La lectura de la imagen y el recálculo del Master se sustituyen: acá se prueba
// QUÉ SE ESCRIBE y QUÉ NO, que es lo único que este módulo decide.
const inspectVoucher = vi.hoisted(() => vi.fn());
const recomputeOrderMasterSafe = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/lib/voucher-inspect", () => ({ inspectVoucher }));
vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe }));

import { reprocessObservedVouchers } from "@/lib/voucher-reprocess";

/** Lectura de visión correcta, con todo legible. */
function reading(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    isVoucher: true,
    fields: {
      operationNumber: "62251837",
      operationLabel: "Código de operación",
      amount: 20,
      paidAt: "2026-08-10T19:35:00.000Z",
      payerName: "Ana Quispe",
      recipientName: "Grupo GF S.A.C.",
      recipientPhoneLastDigits: "309",
      recipientCheck: "verified",
      recipientAccount: { name: "Grupo GF S.A.C.", phoneLastDigits: "309" },
      ...(over.fields as object ?? {}),
    },
    payload: { extracted: { operation_label: "Código de operación" }, ok: true },
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    store_id: "store-1",
    order_id: "order-1",
    kind: "adelanto",
    amount: null,
    operation_number: null,
    paid_at: null,
    payer_name: null,
    file_path: "store-1/order-1/x.jpg",
    validation_status: "info_incompleta",
    vision: { viejo: true },
    ...over,
  };
}

/** Supabase mínimo: registra los updates y los eventos, sirve las filas. */
function stubAdmin(rows: any[], opts: { clash?: any; updateError?: string } = {}) {
  const updates: { id: string; patch: any }[] = [];
  const events: any[] = [];

  const admin: any = {
    from(table: string) {
      let limited: number | null = null;
      const builder: any = {
        _patch: null as any,
        select() {
          return builder;
        },
        in() {
          return builder;
        },
        not() {
          return builder;
        },
        // El listado termina en `.order()` cuando no hay tope y en `.limit()`
        // cuando lo hay, así que el builder tiene que ser encadenable Y
        // esperable a la vez. Un `order()` que devuelve una promesa a secas
        // deja sin probar justo el camino que usa la ruta de cron.
        order() {
          return builder;
        },
        limit(n: number) {
          limited = n;
          return builder;
        },
        then(resolve: (v: any) => void) {
          const slice = limited === null ? rows : rows.slice(0, limited);
          return Promise.resolve({ data: slice, error: null }).then(resolve);
        },
        // findOperationClash termina en .neq()
        eq(_col: string, val: string) {
          if (builder._patch) {
            updates.push({ id: val, patch: builder._patch });
            return Promise.resolve({
              error: opts.updateError ? { message: opts.updateError } : null,
            });
          }
          return builder;
        },
        neq() {
          return Promise.resolve({ data: opts.clash ? [opts.clash] : [], error: null });
        },
        update(patch: any) {
          builder._patch = patch;
          return builder;
        },
        insert(row: any) {
          if (table === "order_events") events.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return { admin, updates, events };
}

describe("reprocessObservedVouchers", () => {
  it("el simulacro calcula todo y NO escribe nada", async () => {
    // El modo por defecto tiene que ser el que no toca la base: esto reescribe
    // la auditoría de visión y rellena campos de pagos.
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates, events } = stubAdmin([payment()]);

    const report = await reprocessObservedVouchers(admin);

    expect(report.wrote).toBe(false);
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
    // Pero sí informa de lo que HARÍA, que es para lo que sirve el simulacro.
    expect(report.filledOperation).toBe(1);
    expect(report.unblocked).toBe(1);
    expect(report.byLabel).toEqual({ "Código de operación": 1 });
    expect(report.byAccount).toEqual({ "Grupo GF S.A.C.": 1 });
  });

  it("solo rellena huecos: nunca pisa un dato que ya tiene valor", async () => {
    // Lo que hay en la fila puede haberlo escrito una persona mirando la imagen,
    // y su lectura manda sobre la del modelo.
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates } = stubAdmin([
      payment({
        amount: 99,
        paid_at: "2026-01-01T00:00:00.000Z",
        payer_name: "Escrito a mano",
        operation_number: "YA-ESTABA",
      }),
    ]);

    const report = await reprocessObservedVouchers(admin, { write: true });

    const patch = updates[0]!.patch;
    expect(patch).not.toHaveProperty("amount");
    expect(patch).not.toHaveProperty("paid_at");
    expect(patch).not.toHaveProperty("payer_name");
    expect(patch).not.toHaveProperty("operation_number");
    expect(report.filledOperation).toBe(0);
    expect(report.filledOther).toBe(0);
    // La auditoría de visión sí se reemplaza: es lectura del modelo, no un dato
    // del operador, y dos versiones de lo que dice la misma imagen sobran.
    expect(patch.vision).toMatchObject({ reprocesado: true, ok: true });
  });

  it("no toca revision_admin aunque el comprobante quede completo", async () => {
    // Ahí hay una persona revisando: vaciarle la cola por nuestra cuenta sería
    // peor que el atasco.
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates } = stubAdmin([payment({ validation_status: "revision_admin" })]);

    const report = await reprocessObservedVouchers(admin, { write: true });

    expect(updates[0]!.patch).not.toHaveProperty("validation_status");
    expect(report.unblocked).toBe(0);
  });

  it("un receptor que no es de ninguna cuenta no desbloquea nada", async () => {
    inspectVoucher.mockResolvedValue(
      reading({ fields: { recipientCheck: "mismatch", recipientAccount: null } }),
    );
    const { admin, updates } = stubAdmin([payment()]);

    const report = await reprocessObservedVouchers(admin, { write: true });

    expect(updates[0]!.patch).not.toHaveProperty("validation_status");
    expect(report.unblocked).toBe(0);
    expect(report.recipientMismatch).toBe(1);
    expect(report.byAccount).toEqual({});
  });

  it("si el nº leído ya lo usa otro pago, NO se escribe y se dice cuál", async () => {
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates } = stubAdmin([payment()], {
      clash: { id: "pay-9", order_id: "order-9", kind: "diferencia", validation_status: "validado" },
    });

    const report = await reprocessObservedVouchers(admin, { write: true });

    expect(updates[0]!.patch).not.toHaveProperty("operation_number");
    expect(report.clashes).toBe(1);
    expect(report.filledOperation).toBe(0);
    expect(report.notes[0]).toMatchObject({ kind: "nº_ya_usado" });
    expect(report.notes[0]!.detail).toContain("pay-9");
  });

  it("si la visión falla, el comprobante se deja INTACTO", async () => {
    // `ok:false` es un fallo, no un veredicto. Cachear una caída de la API como
    // «no dice nada» perdería el comprobante para siempre.
    inspectVoucher.mockResolvedValue({ ...reading(), ok: false });
    const { admin, updates } = stubAdmin([payment()]);

    const report = await reprocessObservedVouchers(admin, { write: true });

    expect(updates).toEqual([]);
    expect(report.visionFailed).toBe(1);
    expect(report.reread).toBe(0);
    expect(report.notes[0]).toMatchObject({ kind: "vision_falló" });
  });

  it("el reloj corta ENTRE comprobantes y cuenta los que quedan", async () => {
    // Partir uno por la mitad dejaría la fila escrita a medias con la auditoría
    // de visión de otra pasada.
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates } = stubAdmin([
      payment({ id: "pay-1" }),
      payment({ id: "pay-2" }),
      payment({ id: "pay-3" }),
    ]);

    let t = 0;
    const report = await reprocessObservedVouchers(admin, {
      write: true,
      deadline: 100,
      now: () => (t += 60), // 60, 120 → el segundo ya pasó del límite
    });

    expect(updates).toHaveLength(1);
    expect(report.deferred).toBe(2);
    expect(report.reread).toBe(1);
  });

  it("deja rastro en el historial solo cuando algo cambió de verdad", async () => {
    inspectVoucher.mockResolvedValue(reading());
    const { admin, events } = stubAdmin([payment()]);

    await reprocessObservedVouchers(admin, { write: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "payment", source: "sistema", order_id: "order-1" });
    expect(events[0].note).toContain("62251837");
    expect(events[0].note).toContain("Código de operación");
  });

  it("un fallo al escribir se informa, no se traga", async () => {
    // 23505: el índice único global rechazó el número. Es la última defensa por
    // debajo de findOperationClash y tiene que verse.
    inspectVoucher.mockResolvedValue(reading());
    const { admin } = stubAdmin([payment()], { updateError: "duplicate key value" });

    const report = await reprocessObservedVouchers(admin, { write: true });

    expect(report.notes[0]).toMatchObject({ kind: "no_se_pudo_escribir" });
    expect(report.notes[0]!.detail).toContain("duplicate key");
  });
});

describe("el tope de la pasada", () => {
  it("respeta `limit` — el camino que usa la ruta de cron", async () => {
    // La consulta termina en `.limit()` cuando hay tope y en `.order()` cuando
    // no: si el builder no fuera encadenable y esperable a la vez, este camino
    // reventaría solo en producción.
    inspectVoucher.mockResolvedValue(reading());
    const { admin, updates } = stubAdmin([
      payment({ id: "pay-1" }),
      payment({ id: "pay-2" }),
      payment({ id: "pay-3" }),
    ]);

    const report = await reprocessObservedVouchers(admin, { write: true, limit: 2 });

    expect(report.candidates).toBe(2);
    expect(updates).toHaveLength(2);
  });

  it("sin tope entran todos", async () => {
    inspectVoucher.mockResolvedValue(reading());
    const { admin } = stubAdmin([payment({ id: "a" }), payment({ id: "b" })]);
    expect((await reprocessObservedVouchers(admin)).candidates).toBe(2);
  });
});
