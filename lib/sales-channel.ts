// Canal de venta de un pedido: por dónde se generó (MOM §3, «Pedido», 15-10-2026).
//
// Todos los pedidos nacen en Shopify, pero no por el mismo camino: el
// formulario COD de la web, un carrito abandonado que se completó, una asesora
// desde Leads, el chatbot de WhatsApp (Kapso), el bot de carritos o el catálogo
// privado de WhatsApp. Lo dicen las etiquetas que cada camino le pone al pedido
// en Shopify. Medido en 45 días hasta el 15-10-2026 (12.336 pedidos):
// formulario 55 %, asesora 15 %, carrito web 15 %, chatbot 9 %, bot de
// carritos 4 %, catálogo 1 %, sin marca 1,5 %.
//
// Un pedido tiene UN canal. Si lleva marcas de dos, gana la primera de
// `SALES_CHANNEL_RULES`: quien cerró la venta (asesora, chatbot, bot) antes que
// la herramienta donde quedó escrita (el formulario web).
//
// Pura y sin dependencias: la usan el recálculo del Master (servidor) y el
// filtro (navegador). La migración 0264 tiene la misma regla en SQL para
// rellenar lo existente; test/sales-channel.test.ts comprueba que coinciden.

export type SalesChannel =
  | "asesora"
  | "chatbot"
  | "bot_carritos"
  | "catalogo"
  | "web_carrito"
  | "web_formulario"
  | "otro";

/** Etiquetas (en minúsculas) de cada canal, en orden de precedencia. */
export const SALES_CHANNEL_RULES: readonly { channel: Exclude<SalesChannel, "otro">; tags: readonly string[] }[] = [
  // Leads: `venta_manual` del borrador nuevo de la asesora (app/dashboard/leads).
  // `carrito_recuperado` era una etiqueta solo de la copia local, que nadie
  // escribe desde MOM §17.3; queda en la regla porque no estorba.
  { channel: "asesora", tags: ["venta_manual", "carrito_recuperado"] },
  // El chatbot de WhatsApp: además de la etiqueta, el pedido trae su conversación.
  { channel: "chatbot", tags: ["kapso", "whatsapp"] },
  // El bot de carritos abandonados («BOT + CARRITO RECUPERADO»).
  { channel: "bot_carritos", tags: ["carrito recuperado", "bot", "bot (whatsapp_cloud)"] },
  // El catálogo privado que se manda al entregar (MOM §31).
  { channel: "catalogo", tags: ["catalogo-wsp"] },
  // Un formulario COD que quedó abandonado y la clienta completó después.
  { channel: "web_carrito", tags: ["easysell-abandoned-checkout", "abandoned_checkout_releasit_cod_form"] },
  // El formulario COD de la web (EasySell / Releasit).
  { channel: "web_formulario", tags: ["easysell_cod_form"] },
];

/** Las opciones del filtro, en el orden en que se enseñan. */
export const SALES_CHANNEL_OPTIONS: readonly { value: SalesChannel; label: string }[] = [
  { value: "web_formulario", label: "Web · formulario" },
  { value: "web_carrito", label: "Web · carrito completado" },
  { value: "asesora", label: "Asesora (Leads)" },
  { value: "chatbot", label: "Chatbot WhatsApp" },
  { value: "bot_carritos", label: "Bot de carritos" },
  { value: "catalogo", label: "Catálogo WhatsApp" },
  { value: "otro", label: "Sin marca" },
];

/** El canal de un pedido por sus etiquetas de Shopify y su conversación de Kapso. */
export function salesChannel(tags: readonly unknown[] | null | undefined, kapsoConversationId?: string | null): SalesChannel {
  const lower = new Set((tags ?? []).filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().toLowerCase()));
  for (const rule of SALES_CHANNEL_RULES) {
    if (rule.channel === "chatbot" && kapsoConversationId) return "chatbot";
    if (rule.tags.some((tag) => lower.has(tag))) return rule.channel;
  }
  return "otro";
}
