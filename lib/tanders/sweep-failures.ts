// Por qué falló cada guía de un barrido de Tanders, en vez de «errores: 200».
//
// EL CASO. El 08-09-2026 las 330 guías Tanders creadas desde julio seguían en
// `PENDING`: ninguna tenía `last_report_at`, `reported_status` ni comprobación
// de pago. El barrido de estados corre cada hora desde el 15-08 y el de cobros
// cada dos, y en tres semanas no habían escrito ni una fila. Los dos envuelven
// cada guía en un `try/catch` que suma uno a `errores` y sigue —correcto para
// que una guía no tumbe a las demás— pero tiraban el error a la basura. El
// reporte decía «errores: 200» y nada más, y con eso no se puede saber si es
// la contraseña, el endpoint o la red.
//
// Esto guarda el MOTIVO, agrupado y acotado: los cinco mensajes distintos más
// frecuentes bastan para diagnosticar, y doscientos iguales no dicen más que
// uno con su cuenta.

import { TandersApiError } from "@/lib/tanders/types";

export interface SweepFailure {
  mensaje: string;
  n: number;
}

/** Motivos distintos que se conservan. Más que esto ya no es diagnóstico, es ruido. */
export const MAX_DISTINCT_FAILURES = 5;

/**
 * El mensaje de un fallo, con lo que hace falta para actuar.
 *
 * Para un error de su API se antepone método, ruta y status: «GET
 * /orders/{id} → 404» distingue «la ruta no existe» de «la contraseña está
 * mal» (401) o «Tanders está caído» (5xx), y eso es exactamente lo que el
 * reporte tiene que decir. El id concreto se reemplaza por `{id}` para que
 * doscientas guías con el mismo problema cuenten como UN motivo.
 */
export function describeSweepError(err: unknown): string {
  if (err instanceof TandersApiError) {
    const route = err.path
      ? ` ${err.method ?? "GET"} ${err.path.replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, "/{id}")}`
      : "";
    return `Tanders${route} → ${err.status}: ${err.message}`.slice(0, 300);
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

/**
 * ¿Es el «todavía no entregada» de la API de evidencias?
 *
 * `GET /orders/me/{id}/aliclik/evidences` responde **400 Order is not yet
 * delivered** mientras el paquete sigue en ruta. Es la respuesta NORMAL de una
 * guía viva, no un fallo: contarla como error infla el reporte y esconde los
 * fallos de verdad —el 08-09 fueron 15 de 15 «errores» que no lo eran—.
 *
 * De paso confirma la regla: la constancia existe solo cuando el motorizado
 * cobró, así que este endpoint ES la prueba de entrega.
 */
export function isNotYetDelivered(err: unknown): boolean {
  return (
    err instanceof TandersApiError &&
    err.status === 400 &&
    /not yet delivered/i.test(err.message)
  );
}

/** Suma un fallo a la lista, agrupando por mensaje y respetando el tope. */
export function recordSweepFailure(list: SweepFailure[], err: unknown): void {
  const mensaje = describeSweepError(err);
  const hit = list.find((f) => f.mensaje === mensaje);
  if (hit) {
    hit.n += 1;
    return;
  }
  if (list.length >= MAX_DISTINCT_FAILURES) {
    const other = list.find((f) => f.mensaje === OTHER_LABEL);
    if (other) other.n += 1;
    else list.push({ mensaje: OTHER_LABEL, n: 1 });
    return;
  }
  list.push({ mensaje, n: 1 });
}

export const OTHER_LABEL = "(otros motivos distintos)";

// ---------------------------------------------------------------------------
// El ritmo
// ---------------------------------------------------------------------------

/**
 * Tanders limita el ritmo: el 08-09-2026, con 200 lecturas seguidas, las
 * últimas 80 volvieron «429 ThrottlerException: Too Many Requests». Las que
 * siguen a un 429 son llamadas perdidas —y, peor, alargan el castigo—, así que
 * el barrido se detiene en el primero y deja el resto para la siguiente pasada.
 */
export function isThrottled(err: unknown): boolean {
  return err instanceof TandersApiError && err.status === 429;
}

/** Pausa entre guías. Un barrido no es una ráfaga: 60 guías a este ritmo son ~20 s. */
export const SWEEP_PACE_MS = 300;

export function pace(ms: number = SWEEP_PACE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
