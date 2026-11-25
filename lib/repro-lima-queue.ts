// «Repro Lima» · el puente entre el tablero y la ficha del pedido (MOM §9.5).
//
// Desde el 07-11-2026 «Atender» abre la ficha del pedido en su pestaña «Repro
// Lima» (`?ficha=<pedido>&seccion=reprolima`). La ficha global vive en el
// layout (order-drawer-host.tsx) y el tablero en la página: no comparten un
// árbol de React. Para «Guardar y pasar al siguiente», el tablero deja aquí
// cuál es el siguiente de SU lista (con sus filtros) y la ficha lo pregunta al
// guardar. Fuera del tablero (Master de Pedidos, otra pantalla) no hay lista:
// la pestaña dice «Guardar» y no pasa a ningún lado.
//
// También lleva el aviso del pedido anterior hasta la ficha del siguiente, que
// es otro montaje de `OrderDrawer`.
//
// Solo memoria del navegador y de esta pestaña: nada se guarda ni se lee de
// la base.

export interface ReproLimaQueue {
  /** El siguiente pedido de la lista del tablero, que nadie más esté atendiendo, o null. */
  next: (orderId: string) => string | null;
}

export interface ReproLimaHandoff {
  orderName: string;
  text: string;
}

let queue: ReproLimaQueue | null = null;
let version = 0;
const listeners = new Set<() => void>();
let handoff: { orderId: string; previous: ReproLimaHandoff } | null = null;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

/** El tablero publica su lista (cada vez que cambia). */
export function setReproLimaQueue(next: ReproLimaQueue): void {
  queue = next;
  emit();
}

/** El tablero se desmonta: solo borra la suya, no la de otro montaje. */
export function clearReproLimaQueue(owner: ReproLimaQueue): void {
  if (queue !== owner) return;
  queue = null;
  emit();
}

/** El siguiente de la lista del tablero, o null sin tablero. */
export function reproLimaNext(orderId: string): string | null {
  return queue?.next(orderId) ?? null;
}

export function subscribeReproLimaQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Cambia cada vez que el tablero publica: `useSyncExternalStore` relee `hasNext`. */
export function reproLimaQueueVersion(): number {
  return version;
}

/** Al pasar al siguiente: el aviso del anterior va arriba de su pestaña. */
export function handOffReproLima(orderId: string, previous: ReproLimaHandoff): void {
  handoff = { orderId, previous };
}

/** El aviso que dejó el pedido anterior para `orderId`, sin consumirlo (StrictMode monta dos veces). */
export function reproLimaHandoff(orderId: string): ReproLimaHandoff | null {
  return handoff?.orderId === orderId ? handoff.previous : null;
}

/** Ya se mostró: no vuelve a salir si se reabre la ficha de ese pedido. */
export function clearReproLimaHandoff(orderId: string): void {
  if (handoff?.orderId === orderId) handoff = null;
}

// ---------------------------------------------------------------------------
// El caso que ESTA pestaña tiene tomado
//
// Tomar y soltar un caso ya no vuelve a pedir la pantalla (owner, 25-11-2026:
// «Repro Lima carga demasiado lento»; medido el 24-11, cada ficha abierta y
// cada ficha cerrada era una lectura entera de los 1.157 pedidos de Lima). La
// fila dice «Lo atiendes tú» por lo que la ficha de esta pestaña tiene tomado,
// no por la última lectura del servidor: esa puede decir «mío» de un caso que
// ya se soltó, o «libre» de uno recién tomado.
// ---------------------------------------------------------------------------

let held: ReadonlySet<string> = new Set();
const claimListeners = new Set<() => void>();

function emitClaims() {
  for (const listener of claimListeners) listener();
}

/** La ficha tomó el caso de este pedido. */
export function holdReproLimaClaim(orderId: string): void {
  if (held.has(orderId)) return;
  held = new Set(held).add(orderId);
  emitClaims();
}

/** La ficha lo soltó, lo perdió o se cerró. */
export function dropReproLimaClaim(orderId: string): void {
  if (!held.has(orderId)) return;
  const next = new Set(held);
  next.delete(orderId);
  held = next;
  emitClaims();
}

/** Los pedidos tomados en esta pestaña. El mismo objeto mientras no cambie (`useSyncExternalStore`). */
export function reproLimaHeldClaims(): ReadonlySet<string> {
  return held;
}

export function subscribeReproLimaClaims(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => {
    claimListeners.delete(listener);
  };
}

/**
 * Lo que la fila enseña del candado. «Mío» es lo que esta pestaña tiene
 * tomado; «otro» siempre viene de la lectura del servidor (y el candado de la
 * base es quien impide atender dos a la vez). Puro.
 */
export function localClaimView<V extends string>(server: V, heldHere: boolean): V | "mio" | "libre" {
  if (heldHere) return "mio";
  return server === "mio" ? "libre" : server;
}

/**
 * Las filas con el candado de esta pestaña encima. Devuelve la MISMA lista si
 * ninguna cambia, para no rehacer lo que depende de ella. Puro.
 */
export function withLocalClaims<R extends { orderId: string; claim: { view: string } }>(rows: readonly R[], heldHere: ReadonlySet<string>): readonly R[] {
  let changed = false;
  const next = rows.map((row) => {
    const view = localClaimView(row.claim.view, heldHere.has(row.orderId));
    if (view === row.claim.view) return row;
    changed = true;
    return { ...row, claim: { ...row.claim, view } } as R;
  });
  return changed ? next : rows;
}
