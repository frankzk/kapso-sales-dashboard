import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_NAMED,
  decideLabelAction,
  listNames,
  isActiveOutput,
  isWithCompany,
  type OutputForDecision,
} from "@/lib/labels/resolve-output";

function out(over: Partial<OutputForDecision> & { id: string }): OutputForDecision {
  return {
    custody_state: "empresa",
    delivery_status: "pendiente",
    created_at: "2026-01-01T00:00:00Z",
    output_number: 1,
    ...over,
  };
}

describe("isActiveOutput", () => {
  it("una salida devuelta NO está activa: el paquete ya volvió", () => {
    expect(isActiveOutput(out({ id: "a", custody_state: "devuelto" }))).toBe(false);
  });
  it("una salida entregada no está activa", () => {
    expect(isActiveOutput(out({ id: "a", delivery_status: "entregado" }))).toBe(false);
  });
  it("pendiente o en ruta con el courier sí está activa", () => {
    expect(isActiveOutput(out({ id: "a", custody_state: "courier", delivery_status: "en_ruta" }))).toBe(true);
    expect(isActiveOutput(out({ id: "b", delivery_status: "pendiente" }))).toBe(true);
  });
});

describe("decideLabelAction", () => {
  it("sin salidas, crea", () => {
    expect(decideLabelAction([])).toEqual({ kind: "create" });
  });

  it("reusa la salida que sigue en la empresa (no crea otra)", () => {
    const decision = decideLabelAction([out({ id: "s1", custody_state: "empresa" })]);
    expect(decision).toEqual({ kind: "reuse", shipmentId: "s1" });
  });

  it("pulsar dos veces no quema el límite: siempre reusa la misma", () => {
    const outputs = [out({ id: "s1", custody_state: "empresa" })];
    expect(decideLabelAction(outputs)).toEqual(decideLabelAction(outputs));
  });

  it("un paquete DEVUELTO no exige justificación: rearmar es reprogramación normal", () => {
    const decision = decideLabelAction([
      out({ id: "s1", custody_state: "devuelto", delivery_status: "pendiente" }),
    ]);
    expect(decision).toEqual({ kind: "create" });
  });

  it("un paquete todavía en la calle exige justificación (MOM §23)", () => {
    const decision = decideLabelAction([
      out({ id: "s1", custody_state: "courier", delivery_status: "en_ruta" }),
    ]);
    expect(decision).toEqual({ kind: "needs_justification", activeOutputs: 1 });
  });

  it("con una devuelta y otra en la calle, manda la que está en la calle", () => {
    const decision = decideLabelAction([
      out({ id: "vieja", custody_state: "devuelto" }),
      out({ id: "activa", custody_state: "courier", delivery_status: "en_ruta" }),
    ]);
    expect(decision).toEqual({ kind: "needs_justification", activeOutputs: 1 });
  });

  it("tener una en la empresa gana aunque exista otra en la calle", () => {
    // Reusar el rótulo de la caja que tenemos es lo correcto: no se crea una
    // tercera salida solo porque haya una circulando.
    const decision = decideLabelAction([
      out({ id: "fuera", custody_state: "courier", delivery_status: "en_ruta" }),
      out({ id: "aqui", custody_state: "empresa", output_number: 2 }),
    ]);
    expect(decision).toEqual({ kind: "reuse", shipmentId: "aqui" });
  });

  it("entre varias en la empresa, la más reciente", () => {
    const decision = decideLabelAction([
      out({ id: "s1", created_at: "2026-01-01T00:00:00Z" }),
      out({ id: "s2", created_at: "2026-03-01T00:00:00Z", output_number: 2 }),
    ]);
    expect(decision).toEqual({ kind: "reuse", shipmentId: "s2" });
  });

  it("isWithCompany distingue custodia", () => {
    expect(isWithCompany(out({ id: "a", custody_state: "empresa" }))).toBe(true);
    expect(isWithCompany(out({ id: "b", custody_state: "courier" }))).toBe(false);
  });
});

describe("listNames (el aviso dice CUÁLES, no solo cuántos)", () => {
  // El aviso decía "3 rótulos reimpresos" y ahí se acababa. La primera pregunta
  // de quien lo lee es cuáles, y no había forma de responderla: reimprimir no
  // crea salida ni deja evento, así que el dato no se podía recuperar después
  // de ninguna manera. El bucle tenía el pedido delante y lo tiraba.
  it("nombra todos cuando son pocos", () => {
    expect(listNames(["#KP131210", "#KP131218", "#KP131225"])).toBe(
      "#KP131210, #KP131218, #KP131225",
    );
  });

  it("recorta y DICE cuántos faltan", () => {
    // Sin la cola, una lista recortada se lee como completa y quien la mira se
    // queda tranquilo creyendo que vio todo.
    const names = Array.from({ length: 8 }, (_, i) => `#KP${i}`);
    const out = listNames(names);
    expect(out).toContain("y 3 más");
    expect(out.split(",")).toHaveLength(MAX_NAMED);
  });

  it("en el límite exacto no dice 'y 0 más'", () => {
    const names = Array.from({ length: MAX_NAMED }, (_, i) => `#KP${i}`);
    expect(listNames(names)).not.toContain("más");
  });

  it("lista vacía es cadena vacía, no '' ni 'y 0 más'", () => {
    expect(listNames([])).toBe("");
  });
});

describe("los reimpresos llegan nombrados al aviso", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/actions.ts"),
    "utf8",
  );

  it("el bucle guarda el pedido cuando decide reimprimir", () => {
    // Es la línea que faltaba: el orderId estaba ahí y se descartaba.
    const i = source.indexOf('if (decision.kind === "reuse")');
    expect(i).toBeGreaterThan(-1);
    expect(source.slice(i, i + 400)).toContain("reusedOrders.push(");
  });

  it("y el nombre viaja en el aviso, no solo en el resultado", () => {
    // Devolverlo sin mostrarlo dejaría el mismo aviso mudo de antes.
    const i = source.indexOf("rótulo${reused === 1");
    expect(i).toBeGreaterThan(-1);
    expect(source.slice(i, i + 200)).toContain("listNames(reusedOrders)");
  });

  it("la consulta trae el nombre del pedido", () => {
    expect(source).toContain("id,order_id,order_name,custody_state");
  });
});
