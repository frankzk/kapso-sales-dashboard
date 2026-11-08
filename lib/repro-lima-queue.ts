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
