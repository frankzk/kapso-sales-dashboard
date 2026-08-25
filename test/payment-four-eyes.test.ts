import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { typedTheOperationNumber } from "@/lib/payment-review";

/**
 * Cuatro ojos sobre el nº de operación.
 *
 * POR QUÉ. El nº de operación es lo que detecta pagos duplicados: el índice
 * único vive sobre esa columna. Cuando lo transcribe una persona desde la
 * imagen, un dígito cambiado NO falla el día que se escribe —el número
 * inventado no choca con nada— y aparece meses después, como un cobro repetido
 * que nadie cazó o un comprobante usado en dos pedidos.
 *
 * Contra eso no sirve revisar con más cuidado. Sirve que lo mire otra persona.
 * Medido antes de escribir la regla: de 13 pagos completados a mano, en 3 la
 * misma persona escribió el número y validó el pago.
 *
 * EL EQUILIBRIO QUE BUSCA. El campo para escribir el número vive en la propia
 * pantalla de validación, porque mandar a quien tiene el comprobante delante a
 * otra pantalla a copiar ocho dígitos era fricción sin contrapartida. Lo que
 * separa las dos responsabilidades es esta regla del servidor, no la
 * navegación — que se salta con dos clics.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const ACTIONS = "app/dashboard/pedidos/payment-actions.ts";

describe("typedTheOperationNumber", () => {
  it("caza a quien valida el número que escribió", () => {
    expect(typedTheOperationNumber("user-a", "user-a")).toBe(true);
  });

  it("deja pasar a cualquier otra persona", () => {
    expect(typedTheOperationNumber("user-a", "user-b")).toBe(false);
  });

  // ESTA ES LA MITAD QUE EVITA LA FRICCIÓN INÚTIL. Si el número lo leyó la
  // visión no hubo transcripción humana que contrastar, y exigir un segundo par
  // de ojos ahí frenaría la cola entera sin proteger nada: hoy el lector acierta
  // el 98,7 % de los comprobantes, así que casi todos entran por esa vía.
  it("no pide nada cuando el número lo leyó la visión", () => {
    expect(typedTheOperationNumber(null, "user-a")).toBe(false);
    expect(typedTheOperationNumber(undefined, "user-a")).toBe(false);
    expect(typedTheOperationNumber("", "user-a")).toBe(false);
  });

  it("un usuario sin identificar no cuenta como coincidencia", () => {
    // Dos nulos son iguales entre sí, y compararlos con `===` a secas habría
    // bloqueado todo pago sin transcriptor conocido.
    expect(typedTheOperationNumber(null, null)).toBe(false);
    expect(typedTheOperationNumber("user-a", null)).toBe(false);
    expect(typedTheOperationNumber("user-a", "")).toBe(false);
  });
});

describe("la regla está conectada donde decide", () => {
  // Las server actions arrastran `next/cache`, `next/headers` y el cliente de
  // Supabase: instanciarlas costaría más andamiaje que el que protege. La regla
  // en sí se prueba arriba de verdad; acá solo se vigila que siga enchufada,
  // que es por donde se caería sin que ninguna prueba se enterase.
  it("validatePayment consulta quién transcribió antes de aprobar", () => {
    const source = read(ACTIONS);
    const start = source.indexOf("export async function validatePayment(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\nexport ", start + 10));
    expect(body).toContain("typedTheOperationNumber(payment.operation_completed_by, ctx.userId)");
    // Y el rechazo va ANTES de escribir el estado: comprobar después de
    // aprobar sería un adorno.
    expect(body.indexOf("typedTheOperationNumber")).toBeLessThan(
      body.indexOf('validation_status: "validado"'),
    );
  });

  it("completePaymentData firma quién escribió el número", () => {
    const source = read(ACTIONS);
    const start = source.indexOf("export async function completePaymentData(");
    const body = source.slice(start, source.indexOf("\nexport ", start + 10));
    expect(body).toContain("patch.operation_completed_by = operation ? ctx.userId : null");
  });

  it("loadPayment trae la columna, o la regla leería siempre undefined", () => {
    // El fallo silencioso más probable de este cambio: la comprobación puesta y
    // el dato sin pedir. `undefined === userId` es false, así que el guardarraíl
    // pasaría a no hacer nada sin que nada fallara.
    expect(read(ACTIONS)).toContain("operation_completed_by,vision,notes");
  });

  it("el pase de relectura NO firma como si fuera una persona", () => {
    // Lo escribe la visión, no alguien: firmarlo obligaría a un segundo par de
    // ojos sobre un dato que ninguna persona transcribió.
    expect(read("lib/voucher-reprocess.ts")).not.toContain("operation_completed_by");
  });

  it("la migración crea la columna que todo esto asume", () => {
    const sql = read("db/migrations/0131_operation_completed_by.sql");
    expect(sql).toContain("add column if not exists operation_completed_by uuid");
    expect(sql).toContain("references auth.users(id)");
  });
});
