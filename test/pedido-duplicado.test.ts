import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  avisoDuplicado,
  cuandoLabel,
  VENTANA_DUPLICADO_HORAS,
  type PedidoPrevio,
} from "@/lib/pedido-duplicado";

/**
 * Avisar cuando el cliente YA tiene pedido, sin volverse ruido.
 *
 * EL CASO. El botón «Generar pedido» de Leads deja registrar una venta de
 * alguien que llamó por teléfono. Eso abre la puerta a cobrarle dos veces lo
 * mismo al mismo cliente.
 *
 * LA CALIBRACIÓN SALE DE LOS DATOS, no de la intuición. En 120 días hay 778
 * pares de pedidos del mismo teléfono y tienda dentro de 48 horas:
 *
 *   pedido anterior ANULADO      536 pares  ← rehacerlo es lo correcto
 *   pedido anterior PENDIENTE    129 pares  ← 99 con los mismos productos
 *   pedido anterior EN PROCESO    65 pares  ← 49 con los mismos productos
 *   pedido anterior ENTREGADO     47 pares  ← recompra rápida, plausible
 *
 * El 69 % viene de un pedido anulado que se rehizo. Avisar ahí sería ruido en
 * dos de cada tres alertas, y una alerta que grita de más se aprende a ignorar
 * en una semana — momento en el que deja de proteger donde importa.
 */

const AHORA = "2026-09-04T12:00:00Z";
const hace = (horas: number) => new Date(Date.parse(AHORA) - horas * 3_600_000).toISOString();

const previo = (over: Partial<PedidoPrevio> = {}): PedidoPrevio => ({
  order_id: "o1",
  name: "#KP1",
  created_at: hace(3),
  total_amount: 178,
  general_status: "pendiente",
  titulos: ["beewax cera de abeja"],
  ...over,
});

describe("lo que SÍ frena", () => {
  it("pedido vivo, mismos productos, hace tres horas", () => {
    // Los 148 casos reales: algo más de uno al día. Es el que justifica frenar.
    const a = avisoDuplicado([previo()], ["Beewax Cera de Abeja"], AHORA);
    expect(a?.riesgo).toBe("duplicado");
    expect(a?.repetidos).toEqual(["beewax cera de abeja"]);
  });

  it("ayer también cuenta", () => {
    expect(avisoDuplicado([previo({ created_at: hace(30) })], ["Beewax Cera de Abeja"], AHORA)?.riesgo)
      .toBe("duplicado");
  });

  it("«en proceso» pesa igual que «pendiente»: el paquete ya va en camino", () => {
    expect(
      avisoDuplicado([previo({ general_status: "en_proceso" })], ["Beewax Cera de Abeja"], AHORA)?.riesgo,
    ).toBe("duplicado");
  });

  it("repetir el pedido AÑADIENDO una unidad sigue siendo duplicado", () => {
    // Es la forma más común del error: se repite todo y de paso se suma algo.
    // Exigir igualdad exacta lo dejaría pasar justo cuando más caro sale.
    const a = avisoDuplicado([previo({ titulos: ["beewax", "softflex"] })], ["Beewax"], AHORA);
    expect(a?.riesgo).toBe("duplicado");
  });
});

describe("lo que NO frena, y es la mitad del diseño", () => {
  it("el pedido ANULADO no avisa: rehacerlo es el flujo normal", () => {
    // 536 de los 778 pares. Avisar aquí convierte la alerta en ruido y la mata.
    expect(avisoDuplicado([previo({ general_status: "anulado" })], ["Beewax"], AHORA)).toBeNull();
  });

  it("pasada la ventana tampoco: un pedido de la semana pasada no es este", () => {
    expect(
      avisoDuplicado([previo({ created_at: hace(VENTANA_DUPLICADO_HORAS + 1) })], ["Beewax"], AHORA),
    ).toBeNull();
  });

  it("un cliente sin pedidos no genera aviso", () => {
    expect(avisoDuplicado([], ["Beewax"], AHORA)).toBeNull();
  });

  it("un pedido con fecha del futuro se ignora: es un dato roto, no una venta", () => {
    expect(avisoDuplicado([previo({ created_at: hace(-5) })], ["Beewax"], AHORA)).toBeNull();
  });
});

describe("los avisos que informan sin frenar", () => {
  it("pedido vivo con OTROS productos: revisar, no duplicado", () => {
    // Puede ser una ampliación legítima; lo que no puede es pasar inadvertida,
    // porque son dos envíos al mismo domicilio.
    const a = avisoDuplicado([previo({ titulos: ["softflex"] })], ["Beewax"], AHORA);
    expect(a?.riesgo).toBe("revisar");
    expect(a?.repetidos).toEqual([]);
  });

  it("ya entregado: recompra, y quien llama debe saberlo", () => {
    const a = avisoDuplicado([previo({ general_status: "entregado" })], ["Beewax"], AHORA);
    expect(a?.riesgo).toBe("recompra");
  });

  it("un entregado ANTIGUO también avisa: la recompra no caduca a las 48 h", () => {
    // La ventana acota la sospecha de duplicado, no el hecho de que ya compró.
    expect(
      avisoDuplicado([previo({ general_status: "entregado", created_at: hace(24 * 40) })], ["X"], AHORA)
        ?.riesgo,
    ).toBe("recompra");
  });
});

describe("con varios pedidos gana el más grave", () => {
  it("un duplicado tapa a una recompra", () => {
    // La pantalla enseña UN aviso; decidir cuál es trabajo de esta regla, no
    // suyo. Devolver la lista entera movería la decisión a la interfaz.
    const a = avisoDuplicado(
      [
        previo({ order_id: "viejo", general_status: "entregado", created_at: hace(24 * 10) }),
        previo({ order_id: "nuevo", general_status: "pendiente", titulos: ["beewax"] }),
      ],
      ["Beewax"],
      AHORA,
    );
    expect(a?.riesgo).toBe("duplicado");
    expect(a?.pedido.order_id).toBe("nuevo");
  });

  it("y el orden en que llegan no cambia cuál gana", () => {
    const lista = [
      previo({ order_id: "nuevo", general_status: "pendiente", titulos: ["beewax"] }),
      previo({ order_id: "viejo", general_status: "entregado", created_at: hace(24 * 10) }),
    ];
    expect(avisoDuplicado(lista, ["Beewax"], AHORA)?.pedido.order_id).toBe("nuevo");
  });
});

describe("el «cuándo» se lee sin hacer cuentas", () => {
  it("dice ayer cuando es ayer", () => {
    expect(cuandoLabel(30)).toBe("ayer");
  });

  it("y las horas cuando es hoy", () => {
    expect(cuandoLabel(0.5)).toBe("hace menos de una hora");
    expect(cuandoLabel(3)).toBe("hace 3 h");
  });

  it("más allá, en días", () => {
    expect(cuandoLabel(24 * 10)).toBe("hace 10 días");
  });
});

describe("las piezas en el código", () => {
  const read = (...p: string[]) =>
    readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("generateOrder consulta el aviso con los productos DE VERDAD", () => {
    // La pantalla previa solo puede mirar estado y fecha; los productos no se
    // saben hasta que el formulario está lleno. Comparar sin ellos dejaría
    // pasar justo el caso que importa.
    const source = read("app/dashboard/leads/actions.ts");
    const start = source.indexOf("export async function generateOrder(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("avisoDuplicado(");
    expect(body).toContain("items.map((li) => String(li.title ?? \"\"))");
  });

  it("y SOLO frena el riesgo `duplicado`", () => {
    // Frenar en `revisar` o `recompra` convertiría la alerta en un peaje: el
    // 69 % de los pares vienen de un pedido anulado que se rehizo.
    const source = read("app/dashboard/leads/actions.ts");
    const start = source.indexOf("export async function generateOrder(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain('aviso?.riesgo === "duplicado"');
  });

  it("el asesor puede pasar por encima confirmando otra vez", () => {
    // Un aviso que no se puede saltar es un bloqueo, y hay ventas legítimas que
    // se parecen a un duplicado. Quien tiene al cliente al teléfono decide.
    const source = read("app/dashboard/leads/actions.ts");
    expect(source).toContain("confirmarDuplicado");
    expect(source).toContain("requiereConfirmacion: true");
  });

  it("la venta telefónica CREA el lead, no un pedido suelto", () => {
    // La acreditación al asesor vive en `lead_calls.lead_id`, que es NOT NULL.
    // Sin lead no hay a quién acreditarle la venta — que es justo lo que este
    // botón viene a arreglar.
    const source = read("app/dashboard/leads/venta-telefonica-actions.ts");
    expect(source).toContain('.from("leads")');
    expect(source).toContain('source: "manual"');
  });

  it("y busca por teléfono ANTES de insertar", () => {
    // `leads` tiene índice único por (tienda, teléfono). Insertar a ciegas haría
    // que la base rechazara la fila después de llenar el formulario.
    const source = read("app/dashboard/leads/venta-telefonica-actions.ts");
    const start = source.indexOf("export async function abrirClienteParaVenta(");
    const body = source.slice(start);
    expect(body.indexOf("consultarClientePorTelefono")).toBeLessThan(body.indexOf(".insert("));
  });
});
