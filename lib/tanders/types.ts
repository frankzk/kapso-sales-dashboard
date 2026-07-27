// Formas de la API de Tanders.
//
// Tanders no publica documentación: todo esto viene de observar su propio
// frontend contra `tander-bakend-…herokuapp.com`. Lo que está CONFIRMADO se
// marca como tal; lo demás se lee de forma defensiva en el cliente, porque un
// backend sin contrato puede renombrar un campo sin avisar.

/** Cajas del formulario. El máximo va en gramos, igual que `weightGrams`. */
export const TANDERS_PACKAGES = [
  { type: "XXS", maxGrams: 250 },
  { type: "XS", maxGrams: 500 },
  { type: "S", maxGrams: 2_000 },
  { type: "M", maxGrams: 5_000 },
] as const;

export type TandersPackageType = (typeof TANDERS_PACKAGES)[number]["type"];

/**
 * Cuerpo de `POST /orders` — CONFIRMADO contra el request real del formulario.
 *
 * La asimetría de tipos es de ellos, no un error de transcripción: el origen
 * viaja como string y el destino como número. Se replica literal porque un
 * backend sin validación declarada puede estar parseando cada uno distinto, y
 * "arreglarlo" es arriesgar un 400 que solo aparecería en producción.
 */
export interface TandersOrderPayload {
  packageType: TandersPackageType;
  weightGrams: number;
  origin: string;
  originLat: string;
  originLng: string;
  destination: string;
  destinationLat: number;
  destinationLng: number;
  recipientFullName: string;
  recipientPhone: string;
  note: string;
  collectionAmount: number;
}

/**
 * Respuesta de `POST /orders` (201). Del detalle del pedido se confirmó `id`
 * (cuid) y `status` ("Pendiente" en la interfaz). El resto se declara opcional:
 * la etiqueta PDF puede llegar con otro nombre o no venir hasta que el pedido
 * se asigna.
 */
export interface TandersOrder {
  id: string;
  status?: string | null;
  code?: string | null;
  labelUrl?: string | null;
  createdAt?: string | null;
  [k: string]: unknown;
}

/** `GET /orders/me/capacity` — cupo del día. La forma exacta no está confirmada. */
export interface TandersCapacity {
  used?: number | null;
  total?: number | null;
  remaining?: number | null;
  [k: string]: unknown;
}

/** Par de tokens de `/auth/login` y `/auth/refresh`. */
export interface TandersTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch en segundos, leído del `exp` del JWT (≈15 min para el access token). */
  expiresAt: number | null;
}

/** Error de la API con el status HTTP, para poder distinguir 401 de 402 de 400. */
export class TandersApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TandersApiError";
  }
}
