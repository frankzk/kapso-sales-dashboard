// Fechas de una guía derivadas de su historial de llamadas. UN cálculo, dos lectores.
//
// Las guías anteriores a las columnas explícitas (0047 `dispatched_at`,
// `closed_at`…) no las tienen, y `shipment_calls` registra cada transición de
// estado, así que se reconstruyen de ahí: el despacho es la PRIMERA vez que la
// guía entró en «en_ruta» y el cierre la ÚLTIMA vez que entró en un estado
// terminal. Cuando la columna explícita existe, manda ella.
//
// LA GESTIÓN CON LA QUE NACE UNA GUÍA DIRECTA NO ES UNA REPROGRAMACIÓN
// (29-09-2026, v1.20). La guía Swayp directa deja una fila `reroute` con
// `new_status` nulo para que cuente en la productividad de quien la creó —lo dice
// su comentario: «cuenta como gestión sin inflar reprogramadas»—. Aquí se leía
// como reprogramación de ESA guía, así que toda guía directa nacía con fecha de
// reprogramación y el Master la mandaba a «Por reprogramar Lima» sin un solo
// intento fallido. Medido: 38 pedidos de Lima (#KP135009) y 32 de provincia en
// «Gestión reproprovincia».
//
// SOLO en la guía directa, y no en cualquier `reroute` sin estado: en julio el
// reenvío por Fenix dejaba esa misma fila, sin estado, en la guía MADRE («Guía
// Fenix creada: …», 149 guías), y ahí sí marca la reprogramación. La v1.19 las
// ignoraba todas y cinco pedidos de julio cayeron en «Preparación · Por armar»
// (#KP117144). Por eso decide quien llama con `directGuide`.
//
// POR QUÉ ESTÁ EN SU PROPIO ARCHIVO. Vivía dentro de `order-master.ts` y solo
// lo usaba el Master. Cuando Envíos empezó a decidir la recuperación con la
// misma regla (`recoveryOutcome`), anclaba la ventana en `closed_at ?? returned_at`
// y el Master en `closed_at ?? (última transición terminal)`. Medido el
// 10-09-2026: de 1.026 guías candidatas, 309 sin `closed_at`; 58 tenían una
// llamada «anulado» más de un día ANTES del retorno. Para el Master la ventana
// ya había vencido; para Envíos seguían activas. La misma pregunta, dos
// respuestas — por dos fórmulas. Ahora es una.

export interface GuideCallLike {
  kind: string;
  new_status: string | null;
  occurred_at: string | null;
}

export interface DerivedGuideDates {
  dispatched_at: string | null;
  rescheduled_at: string | null;
  closed_at: string | null;
  lastCallAt: string | null;
}

export function derivedGuideDates(
  calls: readonly GuideCallLike[],
  /** La guía es una Swayp directa (`created_via = fenix_directo`): su gestión de alta no reprograma. */
  opts: { directGuide?: boolean } = {},
): DerivedGuideDates {
  let dispatched: string | null = null;
  let rescheduled: string | null = null;
  let closed: string | null = null;
  let last: string | null = null;
  for (const c of calls) {
    if (!c.occurred_at) continue;
    if (!last || c.occurred_at > last) last = c.occurred_at;
    if (c.new_status === "en_ruta" && (!dispatched || c.occurred_at < dispatched)) {
      dispatched = c.occurred_at;
    }
    const altaDeGuiaDirecta = opts.directGuide === true && !c.new_status;
    if (c.kind === "reroute" && !altaDeGuiaDirecta && (!rescheduled || c.occurred_at > rescheduled)) {
      rescheduled = c.occurred_at;
    }
    if (
      (c.new_status === "entregado" || c.new_status === "anulado" || c.new_status === "transferido") &&
      (!closed || c.occurred_at > closed)
    ) {
      closed = c.occurred_at;
    }
  }
  return { dispatched_at: dispatched, rescheduled_at: rescheduled, closed_at: closed, lastCallAt: last };
}
