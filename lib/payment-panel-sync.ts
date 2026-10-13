// Los paneles de pago de un mismo pedido se avisan entre sí.
//
// POR QUÉ. La ficha dibuja el cobro en DOS sitios con su propia carga cada uno:
// «Cobro» (registrar y validar comprobantes) y la credencial de Shalom dentro de
// «Salidas y guías» (mostrar y entregar la clave). Registrar la diferencia en el
// primero recargaba solo el primero: el segundo seguía con los pagos de antes y
// «Mostrar clave» seguía apagado hasta actualizar la página (10-10-2026). Cada
// panel avisa cuando cambia algo y los demás del MISMO pedido se recargan.
//
// Un evento del navegador y no un estado compartido: los paneles viven en
// árboles distintos de la ficha (y en el Master), y así ninguno tiene que saber
// dónde está el otro.

const EVENT = "kapta:payment-panel-changed";

interface Detail {
  orderId: string;
  /** Quién avisa: el que cambió ya se recargó y no tiene que volver a hacerlo. */
  source: string;
}

function defaultTarget(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

/** Avisa a los demás paneles de este pedido que sus pagos cambiaron. */
export function announcePaymentPanelChange(
  orderId: string,
  source: string,
  target: EventTarget | null = defaultTarget(),
): void {
  target?.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { orderId, source } }));
}

/**
 * Llama a `onChange` cuando OTRO panel avisa de un cambio en este pedido.
 * Devuelve la función que deja de escuchar.
 */
export function subscribePaymentPanelChange(
  orderId: string,
  source: string,
  onChange: () => void,
  target: EventTarget | null = defaultTarget(),
): () => void {
  if (!target) return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<Detail>).detail;
    if (detail?.orderId === orderId && detail.source !== source) onChange();
  };
  target.addEventListener(EVENT, listener);
  return () => target.removeEventListener(EVENT, listener);
}
