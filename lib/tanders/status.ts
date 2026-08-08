// Traducción del estado de Tanders al MOM.
//
// Tanders no publica documentación y su vocabulario de estados NO está
// confirmado: de las 55 guías creadas hasta hoy, las 55 siguen guardando
// `PENDING` en `tanders_raw` porque nadie volvía a leer el pedido después de
// crearlo. `DELIVERED` se conoce por el barrido de cobros; el resto —lo que
// Tanders diga mientras la ruta avanza— todavía no lo hemos visto nunca.
//
// Por eso esto mapea SOLO lo confirmado y trata lo demás como desconocido: se
// guarda literal y no toca el estado. Es la misma disciplina del adaptador de
// Aliclik, y es lo que impide inventar estados que el MOM no documenta. El
// barrido reporta los valores nuevos que aparezcan: así el vocabulario se
// aprende de la operación real en vez de adivinarse.

/** Estado de una guía Tanders traducido, o desconocido. */
export interface TandersStatusMapping {
  /** Null cuando no sabemos traducirlo: entonces no se toca nada. */
  deliveryStatus: "pendiente" | "en_ruta" | null;
  custodyState: "empresa" | "courier" | null;
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
  PENDING: { deliveryStatus: "pendiente", custodyState: "empresa" },
  DELIVERED: { deliveryStatus: "en_ruta", custodyState: "courier" },
};

/** Normaliza el crudo: su API ha devuelto tanto `PENDING` como `Pendiente`. */
export function tandersStatusCode(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toUpperCase();
  return value === "PENDIENTE" ? "PENDING" : value;
}

export function mapTandersStatus(raw: string | null | undefined): TandersStatusMapping {
  const code = tandersStatusCode(raw);
  const hit = CONFIRMED[code];
  if (!hit) return { deliveryStatus: null, custodyState: null, code, known: false };
  return { ...hit, code, known: true };
}

const CUSTODY_RANK: Record<string, number> = {
  empresa: 0,
  courier: 1,
  devuelto: 2,
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
