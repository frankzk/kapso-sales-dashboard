import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Mover un pago al pedido correcto.
 *
 * EL CASO REAL. El adelanto de S/ 20 de `#KP130268` era de `#KP130243`: un
 * error de dedo al elegir el pedido. Hasta ahora la única salida era rechazar y
 * volver a subir —funciona, porque un rechazo libera el nº de operación— pero
 * deja en el historial de esa clienta un pago RECHAZADO, que se lee como que
 * mandó un comprobante malo. No fue eso lo que pasó.
 *
 * `overridePaymentValidation` hacía justo esto y llevaba desde la 0049 sin que
 * la llamara nadie: ni botón, ni pantalla, ni prueba. Al conectarla salieron
 * dos cosas que había que arreglar ANTES, porque una capacidad muerta no hace
 * daño y una conectada sí.
 *
 * Estas pruebas escanean el fuente: las server actions arrastran `next/cache`,
 * `next/headers` y el cliente de Supabase, y lo que se vigila —qué se comprueba
 * y en qué orden— es estructural.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const ACTIONS = "app/dashboard/pedidos/payment-actions.ts";
const PANEL = "components/pickup-key-panel.tsx";

function overrideBody(): string {
  const source = read(ACTIONS);
  const start = source.indexOf("export async function overridePaymentValidation(");
  expect(start, "no se encontró overridePaymentValidation").toBeGreaterThan(0);
  const end = source.indexOf("\nexport ", start + 10);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("el hueco que había que cerrar antes de conectarla", () => {
  // ANTES: `authorizeOrder(input.targetOrderId ?? payment.order_id)` — solo se
  // comprobaba el DESTINO. Con acceso a una tienda se podía arrastrar un pago
  // de OTRA a un pedido propio: el dinero cambiaba de libro sin que nadie del
  // origen lo autorizara. Conectar el botón sin esto lo habría vuelto
  // explotable desde la interfaz.
  it("comprueba el acceso al pedido de ORIGEN, no solo al de destino", () => {
    const body = overrideBody();
    expect(body).toContain("const source = await authorizeOrder(payment.order_id)");
    expect(body).toContain("Sin acceso al pedido de origen");
    expect(body).toContain("Sin acceso al pedido de destino");
  });

  it("y lo comprueba ANTES de tocar la base", () => {
    const body = overrideBody();
    expect(body.indexOf("Sin acceso al pedido de origen")).toBeLessThan(
      body.indexOf("createAdminSupabase()"),
    );
  });

  // El evento del origen se archivaba con el `store_id` del DESTINO, así que la
  // salida del dinero quedaba anotada en el libro de la otra tienda.
  it("cada evento se escribe en la tienda de SU pedido", () => {
    const body = overrideBody();
    expect(body).toContain("{ orderId: payment.order_id, storeId: source.storeId }");
    expect(body).toContain("store_id: storeId");
  });
});

describe("el destino se resuelve por nombre y con la RLS puesta", () => {
  it("no acepta un uuid crudo desde el navegador", () => {
    // Quien corrige mira «#KP130243» en una pantalla, no un identificador; y
    // aceptar un uuid a pelo dejaba elegir un pedido que no se puede ver.
    const body = overrideBody();
    expect(body).toContain("targetOrderName");
    expect(body).not.toContain("input.targetOrderId");
  });

  it("busca con el cliente del usuario, no con el service role", () => {
    const source = read(ACTIONS);
    const start = source.indexOf("async function resolveOrderByName(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("createServerSupabase()");
    expect(body).not.toContain("createAdminSupabase()");
  });

  it("con dos coincidencias no adivina", () => {
    // Mover dinero al pedido equivocado por elegir el primero es exactamente el
    // error que esta pantalla viene a corregir.
    const source = read(ACTIONS);
    const start = source.indexOf("async function resolveOrderByName(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain(".limit(2)");
    expect(body).toContain("rows.length === 1");
  });

  it("un error de lectura no se lee como «no existe»", () => {
    // Eso mandaría a corregir un nombre que estaba bien escrito.
    const source = read(ACTIONS);
    const start = source.indexOf("async function resolveOrderByName(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("if (error) return null");
  });
});

describe("la corrección no borra lo que ya había", () => {
  it("las notas se acumulan, no se sobrescriben", () => {
    // Sobrescribirlas borraba el motivo por el que el pago estaba observado
    // justo cuando alguien lo corrige, que es cuando más falta hace.
    expect(overrideBody()).toContain('[payment.notes?.trim(), `Corrección: ${reason}`]');
  });

  it("exige motivo y lo escribe en el historial", () => {
    const body = overrideBody();
    expect(body).toContain("Una corrección exige motivo");
    expect(body).toContain("reason,");
  });

  it("recalcula los dos pedidos", () => {
    // El de origen se queda sin ese dinero y el de destino lo gana: si solo se
    // recalculara uno, el otro seguiría mostrando el estado de cobro anterior.
    expect(overrideBody()).toContain("affected.map((a) => a.orderId)");
  });
});

describe("el botón, en la pantalla", () => {
  it("aparece también en un pago YA validado", () => {
    // El error se descubre casi siempre DESPUÉS de validar. Colgarlo de la
    // misma condición que Validar/Rechazar lo habría dejado invisible justo en
    // el caso que viene a resolver.
    const source = read(PANEL);
    const start = source.indexOf("{canOverride && p.validation_status");
    expect(start, "el botón no está donde se esperaba").toBeGreaterThan(0);
    const line = source.slice(start, source.indexOf("\n", start));
    expect(line).toContain('!== "rechazado"');
    expect(line).not.toContain('!== "validado"');
  });

  it("solo se ofrece a quien puede corregir", () => {
    expect(read(PANEL)).toContain("canOverride={panel.canOverride}");
  });

  it("avisa de que queda firmado antes de mover, no después", () => {
    expect(read(PANEL)).toContain("Quedará en el historial de los dos pedidos");
  });
});
