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
//     entren se atienden en la siguiente.
//   * `maxSilenceMs` — cuándo se deja de perseguir una guía muda. Muy por
//     encima de lo que tarda un retorno; es la red para las que Aliclik
//     abandonó sin cerrar.
//
// LA COLA SE ORDENA POR CUÁNDO SE PREGUNTÓ, NO POR CUÁNDO HABLÓ. Parece un
// detalle y era un atasco: ordenando por `last_report_at` —la más callada
// primero— una guía parada se quedaba clavada en cabeza para siempre.
// Preguntar por ella devuelve un snapshot igual o más viejo que el que tenemos,
// la guarda monotónica lo descarta sin escribir, `last_report_at` no se mueve, y
// en la pasada siguiente vuelve a ser la primera. Con cientos de guías vivas y
// un tope por pasada, las de cabeza se consultaban una y otra vez y las del
// fondo no llegaban a tener turno nunca — que es exactamente el atasco que este
// pase existía para deshacer.
//
// `aliclik_followup_at` (0116) registra cuándo se PREGUNTÓ, responda lo que
// responda Aliclik. Es lo único que siempre avanza, así que la rotación queda
// garantizada. Ordena DENTRO de cada familia: la reserva para las guías que
// esperan devolución se reparte antes y no la toca.

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
  /** Último estado que reportó Aliclik, tal cual. Solo se usa para detectar la
   *  guía que va camino de vuelta; puede venir vacío en las nacidas del Excel. */
  reported_status?: string | null;
  /** Cuándo este mismo pase preguntó por ella por última vez. Ordena la cola. */
  aliclik_followup_at?: string | null;
  /** Última lectura de API aplicada. Delata a las que el barrido acaba de ver. */
  api_report_at?: string | null;
}

/**
 * La guía que está a un paso de la devolución.
 *
 * Dos casos: la que Aliclik dice explícitamente que vuelve (`TO_RETURN` / `POR
 * DEVOLVER`), y la anulada —cuyo desenlace pendiente es, justamente, si el
 * paquete regresa—.
 *
 * Importan más que las demás porque el estado que les falta es el ÚNICO que
 * abre la recuperación (MOM §11.1). Una guía viva que se relee tarde solo se ve
 * desactualizada; una devolución que se lee tarde puede quedar fuera de la
 * ventana de frescura y perder la venta entera.
 */
function esperaDevolucion(c: FollowUpCandidate): boolean {
  if (c.delivery_status === "anulado") return true;
  const reported = String(c.reported_status ?? "").toUpperCase();
  return reported.includes("TO_RETURN") || reported.includes("POR DEVOLVER");
}

/**
 * Qué parte de cada pasada se le reserva a esas guías.
 *
 * Es una RESERVA, no una precedencia absoluta, y la diferencia importa. Con
 * orden estricto, las ~850 anuladas se comerían todas las pasadas y las guías
 * vivas —las entregas en curso, que la operación mira a diario— dejarían de
 * releerse durante horas. Con la mitad reservada, ninguna de las dos familias
 * puede matar de hambre a la otra, y la mitad que sobra si un grupo va corto se
 * la queda el otro.
 */
const PRIORITY_SHARE = 0.5;

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
   * Instante desde el cual una lectura de API cuenta como "recién hecha": las
   * guías con `api_report_at` posterior no se vuelven a consultar, porque el
   * barrido por fechas acaba de aplicarles su estado.
   *
   * Sustituye al conjunto de orderNumbers que el barrido iba acumulando en
   * memoria. Tenía que dejar de ser un `Set`: el barrido y este pase ya no
   * comparten invocación, así que la marca tiene que estar en la propia fila.
   *
   * `null` no consulta nada de más — solo renuncia a la exclusión y deja que el
   * orden de la cola haga el trabajo.
   */
  refreshedSince: Date | null;
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

/** Orden ascendente con los nulos primero: nunca visto es lo más urgente. */
function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
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

  const refreshedSince = opts.refreshedSince?.getTime() ?? null;

  const live = candidates.filter((c) => {
    if (TERMINAL.has(c.delivery_status)) return false;
    const key = followUpKey(c);
    if (!key) return false;

    // El barrido por fechas ya le escribió su estado en esta vuelta. Preguntar
    // otra vez gastaría un turno que le hace falta a otra.
    if (refreshedSince !== null && c.api_report_at) {
      const readAt = new Date(c.api_report_at).getTime();
      if (Number.isFinite(readAt) && readAt >= refreshedSince) return false;
    }

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

  // Dentro de cada familia manda el turno: primero a quien hace más que no se le
  // pregunta. Lo que cambia respecto de ordenar solo por silencio es que el
  // turno SIEMPRE avanza —se sella al preguntar— mientras que el silencio de una
  // guía parada no se acorta nunca, y esa era la forma de quedarse clavada en
  // cabeza pasada tras pasada. Con el turno empatado vuelve a mandar la
  // urgencia: la más callada primero.
  const porTurno = (a: FollowUpCandidate, b: FollowUpCandidate) => {
    const turno = byDateAsc(a.aliclik_followup_at ?? null, b.aliclik_followup_at ?? null);
    if (turno !== 0) return turno;
    const señal = byDateAsc(lastSignalAt(a), lastSignalAt(b));
    if (señal !== 0) return señal;
    return a.id.localeCompare(b.id);
  };

  const limit = Math.max(0, opts.limit);
  const enDevolucion = live.filter(esperaDevolucion).sort(porTurno);
  const resto = live.filter((c) => !esperaDevolucion(c)).sort(porTurno);

  // La reserva se reparte primero, y lo que un grupo no use lo aprovecha el
  // otro: si hoy no hay ninguna guía volviendo, la pasada entera es para las
  // vivas, exactamente como antes de este cambio.
  const reservado = Math.min(enDevolucion.length, Math.ceil(limit * PRIORITY_SHARE));
  const due = [
    ...enDevolucion.slice(0, reservado),
    ...resto.slice(0, limit - reservado),
  ];
  // Si el resto no llenó su parte, se completa con más guías en devolución.
  if (due.length < limit) due.push(...enDevolucion.slice(reservado, reservado + (limit - due.length)));

  return {
    due,
    deferred: Math.max(0, live.length - due.length),
    abandoned,
  };
}
