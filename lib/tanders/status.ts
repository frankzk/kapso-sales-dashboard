// Traducción del estado de Tanders al MOM.
//
// Tanders no publica documentación, así que su vocabulario se ha ido
// confirmando contra la operación real en vez de adivinarse. El barrido de
// estados reporta los valores que no sabe traducir, y así aparecieron
// `PICKED`, `RETURNING`, `RETURNED` y `CANCELLED` (10-09-2026): 105 guías en
// estados que el Master no entendía, entre ellas paquetes ya de vuelta en el
// almacén que nadie sabía que habían vuelto.
//
// Lo que no esté acá se sigue tratando como desconocido: se guarda literal y
// NO se toca el estado. Es la misma disciplina del adaptador de Aliclik, y es
// lo que impide inventar estados que el MOM no documenta.

/** Estado de una guía Tanders traducido, o desconocido. */
export interface TandersStatusMapping {
  /** Null cuando no sabemos traducirlo: entonces no se toca nada. */
  deliveryStatus: "pendiente" | "en_ruta" | "anulado" | null;
  custodyState: "empresa" | "courier" | "retorno" | "devuelto" | null;
  /**
   * El paquete está FÍSICAMENTE de vuelta en el almacén. Sella `returned_at`,
   * que es lo que abre la cola de recuperación (MOM §11.1) — distinto de
   * «salió de ruta»: eso es `RETURNING` y todavía no ha llegado.
   */
  returned: boolean;
  /** El valor crudo, normalizado para comparar. */
  code: string;
  known: boolean;
}

/**
 * Estados confirmados.
 *
 * `DELIVERED` NO se traduce a `entregado`. En Tanders el cobro lo hace el
 * motorizado y la regla del negocio (§9.4 y el barrido de cobros) es que la
 * guía solo pasa a `entregado` con la constancia de pago validada. Lo que
 * `DELIVERED` sí acredita es que el paquete salió de la empresa: eso es custodia
 * del courier, y eso sí se escribe.
 */
const CONFIRMED: Record<string, Omit<TandersStatusMapping, "code" | "known">> = {
  PENDING: { deliveryStatus: "pendiente", custodyState: "empresa", returned: false },
  /** Recogido por el motorizado: ya salió, pero nadie lo ha recibido. */
  PICKED: { deliveryStatus: "en_ruta", custodyState: "courier", returned: false },
  DELIVERED: { deliveryStatus: "en_ruta", custodyState: "courier", returned: false },
  /** De camino de vuelta. La guía sigue VIVA: el paquete no ha llegado. */
  RETURNING: { deliveryStatus: "en_ruta", custodyState: "retorno", returned: false },
  /**
   * De vuelta en el almacén, y disponible para volver a salir con otro courier
   * mientras el pedido no se anule en Shopify (confirmado por la operación,
   * 10-09-2026). Por eso cierra la GUÍA (`anulado`) pero no el pedido: el
   * Master lo lee por `returned_at`/custodia y lo manda a recuperación, que es
   * de donde se vuelve a despachar.
   */
  RETURNED: { deliveryStatus: "anulado", custodyState: "devuelto", returned: true },
  /**
   * Anulada en Tanders. NO se toca la custodia: que la guía muera no dice
   * dónde está el paquete, y afirmarlo sin saberlo mandaría a buscar al
   * almacén algo que sigue en la calle.
   */
  CANCELLED: { deliveryStatus: "anulado", custodyState: null, returned: false },
};

/** Normaliza el crudo: su API ha devuelto tanto `PENDING` como `Pendiente`. */
export function tandersStatusCode(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toUpperCase();
  return value === "PENDIENTE" ? "PENDING" : value;
}

export function mapTandersStatus(raw: string | null | undefined): TandersStatusMapping {
  const code = tandersStatusCode(raw);
  const hit = CONFIRMED[code];
  if (!hit) {
    return { deliveryStatus: null, custodyState: null, returned: false, code, known: false };
  }
  return { ...hit, code, known: true };
}

/** Mismo escalafón que Aliclik: el paquete va de la empresa al courier, y de
 *  vuelta pasa por «retorno» antes de estar «devuelto» en el almacén. */
const CUSTODY_RANK: Record<string, number> = {
  empresa: 0,
  courier: 1,
  retorno: 2,
  devuelto: 3,
};

/**
 * La custodia solo avanza. Un snapshot atrasado de Tanders no puede devolver a
 * la empresa un paquete que ya se llevó el motorizado, igual que en Aliclik.
 */
export function reconcileTandersCustodyState(
  current: string | null | undefined,
  incoming: TandersStatusMapping["custodyState"],
): string | null {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  return (CUSTODY_RANK[incoming] ?? 0) > (CUSTODY_RANK[current] ?? 0) ? incoming : current;
}
