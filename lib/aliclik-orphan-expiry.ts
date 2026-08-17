// Caducidad de las intenciones de creación que quedaron en 'pending'.
// Puro + testeado. La regla vive en el MOM §10.2.
//
// EL AGUJERO QUE CIERRA. Crear un pedido en Aliclik se protege con un único
// parcial sobre `aliclik_order_requests` que excluye solo `failed` (ver 0056):
// mientras haya una intención viva, el pedido no admite un segundo intento. Eso
// es correcto para lo que se diseñó —un timeout puede significar que Aliclik SÍ
// creó el pedido, y reintentar a ciegas duplica una escritura irreversible— y el
// barrido de reconciliación resuelve el caso buscando al huérfano.
//
// Pero solo cubre una de las dos ramas. Si Aliclik NUNCA llegó a crear el
// pedido, no hay huérfano que encontrar: el barrido busca, no encuentra, y deja
// la intención en 'pending'. Nadie la cierra jamás. El candado se vuelve
// permanente y el pedido queda inoperable — con un mensaje que además miente,
// porque no hay ninguna creación "en curso ni completada".
//
// Pasó de verdad el 08-08-2026: la API de Aliclik devolvió 500 en la cotización
// y timeout en la creación, y dos pedidos quedaron bloqueados tres horas hasta
// que alguien miró la base a mano.
//
// LA REGLA. Una intención que el barrido lleva `expiryMs` sin encontrar se cierra
// como `failed` con el motivo escrito, y el candado se suelta. La operadora
// reintenta desde el drawer, sin que nadie toque SQL.
//
// LAS CUATRO RETENCIONES, porque soltar el candado de más cuesta dinero — una
// guía duplicada es una escritura real con ventana de cancelación corta:
//
//   * `sweep` ausente o rancio — si no consta un barrido COMPLETO y reciente, NO
//     se caduca nada. No es lo mismo "buscamos y no está" que "no pudimos
//     buscar", y es justo durante una caída de Aliclik cuando ambas cosas se
//     confunden. Sin esta condición, la misma caída que genera los timeouts
//     liberaría los candados que protegen de ellos.
//   * `startedAt` anterior a la intención — un barrido que arrancó antes de que
//     la intención existiera pudo pasar de largo por la zona del listado donde
//     estaría. Su ausencia ahí no prueba nada.
//   * `ambiguousAt` — intenciones que el barrido no pudo descartar porque su
//     teléfono señalaba a varios pedidos abiertos a la vez. Ahí no sabemos si el
//     pedido existe; se quedan para revisión humana.
//   * `expiryMs` — margen para que el rescate normal haga su trabajo. Con el
//     cron cada 20 minutos, 90 minutos son cuatro o cinco barridos fallidos
//     seguidos antes de dar por buena la ausencia.
//
// LA EVIDENCIA VIENE DE FUERA, Y NO ES UN DETALLE. Antes esto se decidía dentro
// de la misma invocación que acababa de recorrer el listado, con un booleano
// local. Esa invocación empezó a morir por `maxDuration` dentro del bucle, y con
// ella murió la caducidad entera: el candado de `#KP127355` duró más de diez
// horas el 10-08-2026. Ahora el barrido deja constancia de sí mismo en
// `aliclik_sweep_state` (0116) y el cierre la lee, así que una pasada lenta ya
// no se lleva por delante al cierre. Lo que NO cambia es la exigencia: sigue
// haciendo falta un barrido completo, y ahora además reciente.

/** La intención huérfana que el barrido no consiguió emparejar. */
export interface ExpiryCandidate {
  id: string;
  orderId: string | null;
  createdAt: string;
  /**
   * Cuándo un barrido dejó esta intención en duda por teléfono ambiguo. Vale
   * para el barrido que la marcó, no para siempre: se compara contra el inicio
   * del último barrido completo.
   */
  ambiguousAt?: string | null;
}

/** Lo que el último barrido COMPLETO dejó anotado sobre sí mismo. */
export interface SweepEvidence {
  /** Cuándo arrancó. Una intención posterior no fue buscada por él. */
  startedAt: string;
  /** Cuándo terminó de recorrer el listado entero. */
  completedAt: string;
  /** Borde antiguo de la ventana de fechas que consultó. */
  windowFrom: string;
}

export interface SelectExpiredOpts {
  /**
   * El último barrido completo del que hay constancia. `null` cuando no hay
   * ninguno: no se caduca nada.
   */
  sweep: SweepEvidence | null;
  /** Antigüedad a partir de la cual se da por no creada. */
  expiryMs: number;
  /**
   * Cuánto vale la constancia de un barrido antes de quedar rancia. Pasado esto
   * volvemos a estar a ciegas, y a ciegas no se suelta ningún candado.
   */
  sweepMaxAgeMs: number;
  now: Date;
}

export interface ExpiryDecision {
  id: string;
  orderId: string | null;
  ageMinutes: number;
  /**
   * `true` si el barrido cubrió de verdad la fecha de creación, es decir si la
   * ausencia está comprobada. `false` es una caducidad por antigüedad a secas.
   */
  verified: boolean;
  /** Lo que queda escrito en la intención, para que el motivo no se pierda. */
  reason: string;
}

export interface ExpirySelection {
  expire: ExpiryDecision[];
  /** Por qué NO se caducó el resto. Se reporta para que un atasco se vea. */
  held: { tooYoung: number; ambiguous: number; noSweep: number; notSearched: number };
}

/** `null` si la fecha no se puede leer, que nunca es lo mismo que cero. */
function msOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * Decide qué intenciones huérfanas se dan por no creadas.
 *
 * Recibe SOLO las que el barrido no consiguió emparejar: las rescatadas ya se
 * cerraron como `sent` y no llegan hasta aquí.
 *
 * Toda fecha ilegible retiene la intención en lugar de caducarla. No poder medir
 * no es haber comprobado, y el sesgo seguro apunta a no soltar el candado.
 */
export function selectExpiredOrphans(
  candidates: readonly ExpiryCandidate[],
  opts: SelectExpiredOpts,
): ExpirySelection {
  const held = { tooYoung: 0, ambiguous: 0, noSweep: 0, notSearched: 0 };
  const nowMs = opts.now.getTime();

  // No consta un barrido completo, o el que consta es viejo o ilegible: esta
  // pasada no demuestra ninguna ausencia.
  const startedAt = msOf(opts.sweep?.startedAt);
  const completedAt = msOf(opts.sweep?.completedAt);
  if (startedAt === null || completedAt === null || nowMs - completedAt > opts.sweepMaxAgeMs) {
    held.noSweep = candidates.length;
    return { expire: [], held };
  }
  // Sin borde de ventana legible no se puede distinguir la ausencia comprobada
  // de la caducidad a secas. `null` degrada a "no verificada", que es el lado
  // que pide mirar el panel antes de reintentar.
  const windowFrom = msOf(opts.sweep?.windowFrom);

  const expire: ExpiryDecision[] = [];

  for (const candidate of candidates) {
    const createdAt = msOf(candidate.createdAt);
    if (createdAt === null || nowMs - createdAt < opts.expiryMs) {
      held.tooYoung++;
      continue;
    }

    // El barrido tiene que haber arrancado DESPUÉS de que la intención
    // existiera. Uno anterior pudo pasar de largo por la zona del listado donde
    // estaría el pedido, y entonces su ausencia no dice nada.
    if (startedAt < createdAt) {
      held.notSearched++;
      continue;
    }

    // La duda por teléfono ambiguo solo retiene si la marcó el mismo barrido del
    // que estamos usando la evidencia. Una duda anterior ya quedó atrás.
    if (candidate.ambiguousAt) {
      const ambiguousAt = msOf(candidate.ambiguousAt);
      if (ambiguousAt === null || ambiguousAt >= startedAt) {
        held.ambiguous++;
        continue;
      }
    }

    const minutes = Math.round((nowMs - createdAt) / 60_000);
    const verified = windowFrom !== null && createdAt >= windowFrom;
    expire.push({
      id: candidate.id,
      orderId: candidate.orderId,
      ageMinutes: minutes,
      verified,
      reason: verified
        ? `Sin rastro en Aliclik tras ${minutes} min de barridos: la creación nunca llegó a existir. ` +
          `Candado liberado, el pedido se puede volver a intentar.`
        : `Intención vencida tras ${minutes} min. Su fecha de creación quedó FUERA de la ventana del ` +
          `barrido, así que la ausencia no pudo comprobarse: revisa el panel de Aliclik antes de reintentar.`,
    });
  }

  return { expire, held };
}

/** La intención viva que hizo chocar al candado (23505). */
export interface LockedIntent {
  status: string;
  order_number: string | null;
  created_at: string;
}

/**
 * Qué se le dice a la operadora cuando el candado rechaza su intento.
 *
 * El mensaje anterior era uno solo para todos los casos —"Ya hay una creación en
 * curso o completada para este pedido"— y en el caso que importa era falso: tras
 * un timeout no hay creación en curso (nadie está esperando nada) ni completada
 * (no hay guía). Quien lo leía no sabía si esperar, reintentar o avisar, y la
 * pantalla no ofrecía ninguna salida.
 *
 * Ahora cada estado dice lo suyo y, sobre todo, dice CUÁNDO se resuelve solo.
 */
export function lockedIntentMessage(
  intent: LockedIntent | null,
  opts: { expiryMs: number; now: Date },
): string {
  if (!intent) {
    // La intención desapareció entre el choque y esta consulta. Raro, pero el
    // reintento es inocuo: el candado ya no está.
    return "Otra creación para este pedido acaba de terminar. Vuelve a intentarlo.";
  }

  if (intent.status === "sent" || intent.status === "duplicate") {
    const number = (intent.order_number ?? "").trim();
    return number
      ? `Este pedido ya tiene una guía en Aliclik (N.º ${number}). Búscala en Salidas y guías.`
      : "Este pedido ya tiene una creación completada en Aliclik. Revísala en su panel.";
  }

  if (intent.status !== "pending") {
    return "Ya hay una creación registrada para este pedido.";
  }

  const at = new Date(intent.created_at).getTime();
  const elapsed = Number.isFinite(at) ? opts.now.getTime() - at : 0;
  const left = Math.max(0, Math.ceil((opts.expiryMs - elapsed) / 60_000));

  return (
    "Hay un intento anterior esperando confirmación de Aliclik: no respondió a tiempo y el pedido PUEDE " +
    "haberse creado. No reintentes todavía — el barrido lo comprueba cada 20 minutos, y si Aliclik nunca " +
    (left > 0
      ? `llegó a crearlo el pedido se libera solo en ~${left} min.`
      : "llegó a crearlo el pedido se libera en el próximo barrido.")
  );
}
