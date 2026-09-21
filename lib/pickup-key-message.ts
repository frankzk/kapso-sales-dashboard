// El mensaje con el que la clave de recojo llega a la clienta, y la única
// ventana por la que puede salir.
//
// POR QUÉ ESTÁ AQUÍ Y NO EN LA ACCIÓN. La pantalla enseña ANTES de enviar el
// texto exacto que se va a mandar, y la acción manda el que se envía de verdad.
// Si fueran dos plantillas, el día que alguien retoque una la pantalla estaría
// prometiendo un mensaje que no es el que sale. Es la misma función, con la
// clave tapada para el navegador: `loadPaymentPanel` NUNCA devuelve la clave, y
// esa regla no se rompe ni para una vista previa.
//
// LA VENTANA DE 24 H NO ES NUESTRA. WhatsApp solo deja mandar texto libre
// dentro de las 24 h desde que la clienta escribió; fuera de eso hace falta una
// plantilla aprobada, y una plantilla con la clave dentro no existe. Así que
// cuando la ventana está cerrada esto NO manda nada y lo dice: la clave la
// entrega una persona, como hasta hoy. Callarlo sería peor que no enviarla,
// porque el equipo daría por entregada una clave que nunca salió.

/** Horas desde el último mensaje de la clienta en las que se puede escribir. */
export const KEY_SEND_WINDOW_HOURS = 24;

/** Lo que se pinta en lugar de la clave cuando el texto viaja al navegador. */
export const KEY_MASK = "••••••";

export interface PickupKeyMessageFacts {
  customerName: string | null;
  orderName: string | null;
  agencyName: string | null;
  guideCode: string | null;
}

/** El primer nombre, que es como se saluda; sin nombre, no se saluda a nadie. */
function firstName(name: string | null): string | null {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const n = parts[0]!;
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

/**
 * El mensaje que recibe la clienta. `key` tapada (`KEY_MASK`) es la vista
 * previa; con la clave de verdad es lo que sale por WhatsApp.
 *
 * Sin fechas y sin amenazas, por la misma decisión que el aviso de llegada: se
 * le dice lo que necesita para recoger y se le agradece. El plazo de la agencia
 * ya se lo recuerda el aviso de Shalom.
 */
export function pickupKeyMessage(facts: PickupKeyMessageFacts, key: string): string {
  const nombre = firstName(facts.customerName);
  const lineas = [
    nombre ? `✅ ¡Listo, ${nombre}! Confirmamos tu pago completo.` : "✅ ¡Listo! Confirmamos tu pago completo.",
    "",
    `Tu clave de recojo es: *${key}*`,
    "",
    facts.agencyName
      ? `Preséntala con tu DNI en la agencia Shalom de ${facts.agencyName} para recoger tu pedido.`
      : "Preséntala con tu DNI en la agencia Shalom donde llegó tu pedido.",
  ];
  if (facts.guideCode) lineas.push(`Guía: ${facts.guideCode}`);
  lineas.push("", "¡Gracias por tu compra! 💜");
  return lineas.join("\n");
}

/**
 * ¿Se le puede escribir texto libre ahora mismo?
 *
 * `lastInboundAt` es lo último que sabemos que escribió ella. Si no consta
 * ninguno, la respuesta es NO: no se asume una ventana abierta por no tener el
 * dato, porque el coste de equivocarse es un envío rechazado que el equipo da
 * por bueno.
 */
export function keySendWindowOpen(
  lastInboundAt: string | null | undefined,
  nowIso: string,
): boolean {
  if (!lastInboundAt) return false;
  const t = Date.parse(lastInboundAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return false;
  return now - t <= KEY_SEND_WINDOW_HOURS * 3600 * 1000;
}
