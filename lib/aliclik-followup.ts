// Seguimiento de las guías que siguen vivas fuera de la ventana del barrido.
// Puro + testeado.
//
// EL PROBLEMA. El cron de reconciliación relee los últimos LOOKBACK_DAYS días
// pidiéndole a Aliclik un rango de fechas. Eso cubre bien el ciclo normal —
// confirmar, despachar, entregar — porque cabe de sobra en dos semanas. Pero la
// DEVOLUCIÓN no: un paquete que la clienta rechaza entra en `TO_RETURN` y tarda
// semanas en volver al origen y convertirse en `RETURNED`. Para cuando Aliclik
// tiene esa noticia, la guía ya se cayó del rango y nadie vuelve a preguntar por
// ella. El estado final existe en Aliclik y no llega nunca: por eso el Master
// puede quedarse con cero devueltos indefinidamente, y con él la entrada a
// Reproprovincia que el MOM §11 hace depender de la devolución.
//
// LA SOLUCIÓN. Después del barrido por fechas se persigue, una por una, a las
// guías que siguen vivas y que el rango no tocó. El ancla deja de ser la fecha y
// pasa a ser el estado: mientras una guía no haya terminado, se le pregunta.
//
// DOS TOPES, porque "preguntar para siempre" tampoco vale:
//   * `limit` — cuántas consultas individuales caben en una pasada. Las que no
//     entren se atienden en la siguiente: el orden es por antigüedad del último
//     reporte, así que la cola rota y ninguna guía se queda sin turno.
//   * `maxSilenceMs` — cuándo se deja de perseguir una guía muda. Muy por
//     encima de lo que tarda un retorno; es la red para las que Aliclik
//     abandonó sin cerrar.

/** Estados en los que la guía ya terminó su vida y no hay nada que preguntar. */
const TERMINAL = new Set(["entregado", "transferido"]);

/**
 * `anulado` NO cierra el seguimiento, aunque lo parezca.
 *
 * Una guía se anula cuando la clienta cancela o se agotan los intentos — y el
 * paquete VUELVE después, no antes. Ese retorno es justo el hecho que abre la
 * recuperación (MOM §11), y ocurre cuando ya habíamos dejado de mirar: la guía
 * salía del barrido al anularse, y el Excel dejaba de traerla poco después. El
 * resultado era una guía congelada en el estado anterior a lo único que
 * importaba de ella.
 *
 * Se sigue mirando, pero con menos paciencia que una viva: una anulada de hace
 * tres semanas ya no va a volver, y perseguirla es gastar consultas en algo que
 * no va a cambiar.
 */
const RETURN_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;

/** Cuánto silencio se le tolera a una guía según su estado. */
function silenceBudgetMs(deliveryStatus: string, maxSilenceMs: number): number {
  return deliveryStatus === "anulado" ? Math.min(RETURN_WINDOW_MS, maxSilenceMs) : maxSilenceMs;
}

/** La fila de `shipments` que necesita el selector. */
export interface FollowUpCandidate {
  id: string;
  external_order_number: string | null;
  guide_code: string | null;
  delivery_status: string;
  last_report_at: string | null;
  created_at: string | null;
}

/**
 * Con qué identificador se le pregunta a Aliclik por esta guía.
 *
 * Son el MISMO espacio de nombres: el `orderNumber` que devuelve la API es el
 * código AUR5X que también trae el reporte, y en las guías que tienen los dos
 * campos coinciden todas. Por eso `guide_code` sirve de respaldo y no es un
 * identificador distinto — es el mismo dato por otra vía.
 *
 * Importa porque solo las guías que creamos nosotros por API traen
 * `external_order_number`: 601 de 3.870. Y mirando solo las VIVAS, que son las
 * que este pase persigue, 277 de 583 no lo tienen — casi la mitad quedaría sin
 * consultar, y son justo las que se congelan cuando nadie sube un reporte.
 */
export function followUpKey(c: FollowUpCandidate): string {
  return (c.external_order_number ?? "").trim() || (c.guide_code ?? "").trim();
}

export interface SelectFollowUpOpts {
  /**
   * orderNumbers que el barrido por fechas YA visitó en esta pasada. No se
   * vuelven a consultar: acaban de aplicarse.
   */
  scanned: ReadonlySet<string>;
  /** Tope de consultas individuales de esta pasada. */
  limit: number;
  maxSilenceMs: number;
  now: Date;
}

export interface FollowUpSelection {
  /** Las que se consultan ahora, de la más callada a la más reciente. */
  due: FollowUpCandidate[];
  /**
   * Cuántas quedaron vivas y sin turno por el `limit`. Se reporta para que un
   * atasco se vea: si esto no baja a cero entre pasadas, el tope está corto.
   */
  deferred: number;
  /** Cuántas se dieron por abandonadas por silencio. */
  abandoned: number;
}

/** El instante del que se mide el silencio. Sin reporte, vale la creación. */
function lastSignalAt(c: FollowUpCandidate): string | null {
  return c.last_report_at ?? c.created_at;
}

/**
 * Decide a qué guías vivas hay que preguntarles por su cuenta.
 *
 * Se descarta una guía cuando ya terminó, cuando no tenemos con qué preguntar
 * (ni `external_order_number` ni `guide_code`: sin identificador no hay consulta
 * posible), cuando el barrido por fechas acaba de verla, o cuando lleva callada
 * más de `maxSilenceMs`.
 *
 * El resto se ordena por señal más antigua primero. Una guía sin fecha ninguna
 * se trata como la más urgente: es la que más tiempo lleva sin que nadie mire.
 */
export function selectFollowUpGuides(
  candidates: readonly FollowUpCandidate[],
  opts: SelectFollowUpOpts,
): FollowUpSelection {
  let abandoned = 0;

  const live = candidates.filter((c) => {
    if (TERMINAL.has(c.delivery_status)) return false;
    const key = followUpKey(c);
    if (!key) return false;
    if (opts.scanned.has(key)) return false;
    const floor = opts.now.getTime() - silenceBudgetMs(c.delivery_status, opts.maxSilenceMs);

    const signal = lastSignalAt(c);
    if (signal) {
      const at = new Date(signal).getTime();
      // Una fecha ilegible no descarta la guía: no saber cuándo habló no es lo
      // mismo que saber que lleva callada demasiado.
      if (Number.isFinite(at) && at < floor) {
        abandoned++;
        return false;
      }
    }
    return true;
  });

  live.sort((a, b) => {
    const sa = lastSignalAt(a);
    const sb = lastSignalAt(b);
    if (sa === sb) return a.id.localeCompare(b.id);
    if (!sa) return -1;
    if (!sb) return 1;
    return sa < sb ? -1 : 1;
  });

  const limit = Math.max(0, opts.limit);
  return {
    due: live.slice(0, limit),
    deferred: Math.max(0, live.length - limit),
    abandoned,
  };
}
