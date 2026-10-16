// El escaneo de un paquete que ya está en la caja del mismo motorizado (MOM
// §29.13). «Ya estaba», a secas, no decía en qué carga ni qué faltaba.
//
// El 12-10-2026 #KP139615 volvió de la ruta del 08/10 y el escaneo lo puso en
// la Carga 5 de Alexis, que nadie verificó. La parada de la ruta se crea al
// verificar y entregar la carga, así que el pedido no salía en la hoja de
// Alexis; el segundo escaneo respondía «Ya estaba» y parecía que no estaba en
// ningún lado. Ahora el aviso dice la carga y el paso que falta.

/** En qué punto está la carga donde ya está el paquete. */
export type AlreadyInBoxStage = "por_verificar" | "por_entregar" | "entregada";

export function alreadyInBoxStage(input: { officeCheckedAt: string | null; manifestState: string | null }): AlreadyInBoxStage {
  if (input.manifestState === "in_custody") return "entregada";
  return input.officeCheckedAt ? "por_entregar" : "por_verificar";
}

function where(riderName: string, loadNumber: number | null): string {
  return loadNumber ? `la Carga ${loadNumber} de ${riderName}` : `la caja de ${riderName}`;
}

/** El aviso entero (el `title` de la fila y lo que devuelve el servidor). */
export function alreadyInBoxMessage(input: { riderName: string; loadNumber: number | null; stage: AlreadyInBoxStage }): string {
  const place = where(input.riderName, input.loadNumber);
  switch (input.stage) {
    case "por_verificar":
      return `Ya está en ${place}: falta verificar esa carga en «Cajas de hoy». Hasta entonces no sale en su ruta.`;
    case "por_entregar":
      return `Ya está en ${place}, verificado en oficina: falta entregársela.`;
    case "entregada":
      return `Ya está en ${place}, que ${input.riderName} ya tiene.`;
  }
}

/** La chapa de la fila: corta, con la carga y lo que falta. */
export function alreadyInBoxChip(input: { riderName: string; loadNumber?: number | null; stage?: AlreadyInBoxStage | null }): string {
  const place = input.loadNumber ? `la Carga ${input.loadNumber}` : "su caja";
  switch (input.stage) {
    case "por_verificar":
      return `Ya está en ${place} · falta verificarla`;
    case "por_entregar":
      return `Ya está en ${place} · falta entregarla`;
    case "entregada":
      return `Ya está en ${place} · la tiene ${input.riderName}`;
    default:
      return `Ya está en ${place}`;
  }
}
