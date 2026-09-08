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
