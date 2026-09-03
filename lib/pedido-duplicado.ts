// ¿Este cliente ya tiene un pedido que hace sospechar que el nuevo sobra?
//
// EL CASO. El botón «Generar pedido» de Leads deja crear una venta para alguien
// que llamó por teléfono y no está en la cola. Eso abre la puerta a cobrarle dos
// veces al mismo cliente lo mismo: dos asesoras atienden la misma llamada, o la
// misma asesora no recuerda que ya lo registró hace una hora.
//
// POR QUÉ NO BASTA CON «YA TIENE PEDIDO». Medido sobre 120 días, hay 778 pares
// de pedidos del mismo teléfono y tienda dentro de 48 horas. Pero:
//
//   pedido anterior ANULADO      536 pares  ← rehacerlo es lo correcto
//   pedido anterior PENDIENTE    129 pares  ← 99 con los mismos productos
//   pedido anterior EN PROCESO    65 pares  ← 49 con los mismos productos
//   pedido anterior ENTREGADO     47 pares  ← recompra rápida, plausible
//
// El 69 % de los pares vienen de un pedido anulado que se rehizo. Avisar ahí es
// ruido, y una alerta que grita de más se aprende a ignorar en una semana —
// momento en el que deja de proteger también en los casos que importan.
//
// Lo que de verdad huele mal son los 148 con el pedido anterior VIVO y los
// MISMOS productos: algo más de uno al día.

/** Un pedido previo del mismo cliente en la misma tienda. */
export interface PedidoPrevio {
  order_id: string;
  name: string | null;
  created_at: string;
  total_amount: number | null;
  /** Estado del MOM: pendiente, en_proceso, entregado, anulado, devuelto. */
  general_status: string | null;
  /** Títulos de sus líneas, ya normalizados por quien consulta. */
  titulos: string[];
}

export type RiesgoDuplicado = "duplicado" | "revisar" | "recompra" | "ninguno";

export interface AvisoDuplicado {
  riesgo: RiesgoDuplicado;
  pedido: PedidoPrevio;
  /** Horas entre el pedido previo y ahora, para decirlo en pantalla. */
  horas: number;
  /** Los productos que se repiten, si los hay. */
  repetidos: string[];
}

/** Un pedido anulado no compite con uno nuevo: rehacerlo es el flujo normal. */
const VIVOS = new Set(["pendiente", "en_proceso"]);

/** La ventana en la que dos pedidos iguales son sospechosos, en horas. */
export const VENTANA_DUPLICADO_HORAS = 48;

export function normalizaTitulo(titulo: string): string {
  return titulo.trim().toLowerCase();
}

/**
 * El aviso más fuerte que merece este cliente, o null si ninguno.
 *
 * Los cuatro niveles y por qué son cuatro y no dos:
 *
 *   `duplicado` — pedido VIVO, MISMOS productos, dentro de 48 h. Es el que
 *                 justifica frenar: casi seguro es la misma venta dos veces.
 *   `revisar`   — pedido VIVO dentro de 48 h con otros productos. Puede ser una
 *                 ampliación legítima, pero conviene mirar antes de duplicar el
 *                 envío al mismo domicilio.
 *   `recompra`  — ya le entregamos algo. No es un error, es información: quien
 *                 llama debe saberlo para no tratarlo como cliente nuevo.
 *   `ninguno`   — incluido el pedido anulado, que es el 69 % de los casos.
 *
 * Devuelve UN aviso, el más grave, con el pedido que lo provoca. Devolver la
 * lista entera obligaría a la pantalla a decidir cuál enseñar, y esa decisión
 * es esta regla.
 */
export function avisoDuplicado(
  previos: readonly PedidoPrevio[],
  productosNuevos: readonly string[],
  ahoraIso: string,
): AvisoDuplicado | null {
  const ahora = Date.parse(ahoraIso);
  if (Number.isNaN(ahora)) return null;
  const nuevos = new Set(productosNuevos.map(normalizaTitulo).filter(Boolean));

  const orden: RiesgoDuplicado[] = ["duplicado", "revisar", "recompra", "ninguno"];
  let mejor: AvisoDuplicado | null = null;

  for (const previo of previos) {
    const creado = Date.parse(previo.created_at);
    if (Number.isNaN(creado)) continue;
    const horas = (ahora - creado) / 3_600_000;
    // Un pedido del futuro es un dato roto, no una venta reciente.
    if (horas < 0) continue;

    const suyos = previo.titulos.map(normalizaTitulo).filter(Boolean);
    const repetidos = suyos.filter((t) => nuevos.has(t));
    const estado = (previo.general_status ?? "").trim().toLowerCase();

    let riesgo: RiesgoDuplicado = "ninguno";
    if (VIVOS.has(estado) && horas <= VENTANA_DUPLICADO_HORAS) {
      // «Mismos productos» es que el nuevo NO trae nada que el viejo no tuviera.
      // Pedir igualdad exacta dejaría pasar el caso más común del error: repetir
      // el pedido y aprovechar para añadir una unidad más.
      riesgo = repetidos.length > 0 && repetidos.length === nuevos.size ? "duplicado" : "revisar";
    } else if (estado === "entregado") {
      riesgo = "recompra";
    }
    if (riesgo === "ninguno") continue;

    if (!mejor || orden.indexOf(riesgo) < orden.indexOf(mejor.riesgo)) {
      mejor = { riesgo, pedido: previo, horas, repetidos };
    }
  }
  return mejor;
}

export const RIESGO_TITULO: Record<Exclude<RiesgoDuplicado, "ninguno">, string> = {
  duplicado: "Este cliente ya tiene este mismo pedido",
  revisar: "Este cliente ya tiene un pedido abierto",
  recompra: "A este cliente ya le entregamos un pedido",
};

/** Cómo se dice el «cuándo» sin hacer cuentas mentales. */
export function cuandoLabel(horas: number): string {
  if (horas < 1) return "hace menos de una hora";
  if (horas < 24) return `hace ${Math.round(horas)} h`;
  if (horas < 48) return "ayer";
  const dias = Math.round(horas / 24);
  return `hace ${dias} días`;
}
