// Cuánto hay que cobrar en la puerta, escrito para leerse de un vistazo.
//
// Es el dato más caro de equivocar del rótulo: cobrar de menos es plata perdida
// y cobrar de más es una devolución con el cliente molesto. La fuente es
// `orders.total_amount` — el Total de Shopify, ya con descuentos e impuestos —,
// la misma que ya usan la ruta del motorizado (`order_master.order_total`) y el
// cálculo de lo que Aliclik va a cobrar (`lib/aliclik-money.ts`).
//
// Los importes se escriben con las fuentes estándar del PDF, que son WinAnsi:
// nada de separadores tipográficos ni símbolos raros que no estén en la tabla.

/** Símbolo por moneda; lo que no conocemos se imprime con su código ISO. */
const SYMBOLS: Record<string, string> = {
  PEN: "S/",
  USD: "$",
  EUR: "EUR",
  CLP: "$",
  COP: "$",
  MXN: "$",
};

function symbolFor(currency: string | null | undefined): string {
  const code = (currency ?? "PEN").trim().toUpperCase();
  return SYMBOLS[code] ?? code;
}

/** Miles con coma; céntimos solo cuando los hay. */
function formatNumber(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const hasCents = Math.abs(rounded % 1) > 1e-9;
  const [whole, cents] = rounded.toFixed(hasCents ? 2 : 0).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents ? `${grouped}.${cents}` : grouped;
}

/**
 * El monto a cobrar tal como va impreso, o `null` si no lo sabemos.
 *
 * `null` NO es cero. Una salida sin pedido vinculado no tiene total, y escribir
 * "0" ahí haría que el motorizado entregue sin cobrar. Quien llama decide qué
 * poner en su lugar; aquí nunca se inventa una cifra.
 */
export function formatCollectAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount == null) return null;
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  return `${symbolFor(currency)} ${formatNumber(value)}`;
}
