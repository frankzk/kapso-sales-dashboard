// Por qué Grupo GF no puede tomar un pedido que ya tiene la salida de otro
// courier, dicho con nombre (09-10-2026).
//
// Escanear la S02 de #KP139675 en la caja de Alexis decía «El pedido ya tiene
// una salida asignada a otro courier», y la S01 «El pedido ya avanzó y salió
// de Pedidos disponibles». Ninguna decía cuál ni de quién: la S02 era de Axel
// Courier y la S01 seguía en ruta con Swayp. Aquí se nombra cada salida, dónde
// está y qué hacer.

import { nombreDeCourier } from "@/lib/shipment-output";

export interface AdmissionOutputLike {
  id?: string;
  courier: string | null;
  output_code?: string | null;
  delivery_status: string;
  custody_state?: string | null;
  dispatched_at?: string | null;
}

/** Couriers que no estorban a Grupo GF: el propio y la salida por definir. */
const NOT_OTHER = new Set(["propio", "por_definir", ""]);

function inWarehouse(output: AdmissionOutputLike): boolean {
  return !output.dispatched_at && (output.custody_state ?? "empresa") === "empresa";
}

/**
 * Las salidas vivas de otro courier, en una frase con su qué hacer. Null si no
 * hay ninguna (el motivo es otro y se dice con el texto de siempre).
 */
export function otherCourierBlockMessage(outputs: readonly AdmissionOutputLike[]): string | null {
  const others = outputs.filter(
    (o) =>
      ["pendiente", "en_ruta", "por_preparar"].includes(o.delivery_status) &&
      !NOT_OTHER.has((o.courier ?? "").trim().toLowerCase()),
  );
  if (others.length === 0) return null;
  const parts = others.map((o) => {
    const name = o.output_code || "Una salida";
    const courier = nombreDeCourier(o.courier);
    return inWarehouse(o) ? `${name} es de ${courier} y sigue en almacén` : `${name} está en ruta con ${courier}`;
  });
  const hints: string[] = [];
  if (others.some(inWarehouse)) hints.push("anula la de almacén en la ficha («Salidas y guías»)");
  if (others.some((o) => !inWarehouse(o))) hints.push("registra antes el resultado de la que está en ruta");
  return `${parts.join(" · ")}. Para llevarlo en Grupo GF, ${hints.join(" y ")}.`;
}
