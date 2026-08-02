// Por qué falló la cámara, en palabras que sirvan a quien está en el almacén.
//
// El lector de QR fallaba con un único mensaje ("revisa el permiso") sin importar
// la causa. Cuando la causa real fue el header `Permissions-Policy: camera=()`
// del propio servidor, ese texto mandó a buscar durante días un permiso de
// Android que siempre estuvo bien: el navegador nunca llegó a preguntar.
//
// Cada rama de aquí dice qué hacer. La última mantiene el nombre técnico del
// error a la vista, porque un mensaje genérico es exactamente lo que costó caro.

/** Qué hacer para que el lector vuelva a abrir. */
export type CameraFailure =
  | "unsupported"
  | "insecure"
  | "denied"
  | "not_found"
  | "in_use"
  | "unknown";

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/**
 * Clasifica el rechazo de `getUserMedia`.
 *
 * `secureContext` es lo que ve el navegador: fuera de HTTPS (y de localhost) la
 * API ni siquiera existe, y conviene decirlo antes de culpar al permiso.
 */
export function classifyCameraError(error: unknown, secureContext = true): CameraFailure {
  if (!secureContext) return "insecure";
  switch (errorName(error)) {
    // El navegador bloqueó el acceso: permiso denegado por la persona O por la
    // Permissions-Policy del servidor. Desde el cliente son indistinguibles.
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    // No hay cámara conectada.
    case "NotFoundError":
    case "OverconstrainedError":
      return "not_found";
    // El hardware existe pero otra app lo tiene tomado.
    case "NotReadableError":
    case "AbortError":
      return "in_use";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

const MESSAGES: Record<CameraFailure, string> = {
  unsupported: "Este navegador no permite abrir la cámara. Usa Chrome o el campo manual.",
  insecure: "La cámara solo funciona sobre HTTPS. Abre el enlace seguro o usa el campo manual.",
  denied:
    "El navegador bloqueó la cámara. Tócale al candado de la barra de direcciones, " +
    "activa «Cámara» y recarga. Mientras tanto, usa el campo manual.",
  not_found: "No encontramos ninguna cámara en este equipo. Usa el campo manual.",
  in_use: "Otra aplicación está usando la cámara. Ciérrala y vuelve a intentar.",
  unknown: "No pudimos abrir la cámara. Usa el campo manual.",
};

/** Mensaje para el operador; incluye el nombre técnico cuando no lo reconocemos. */
export function cameraErrorMessage(error: unknown, secureContext = true): string {
  const failure = classifyCameraError(error, secureContext);
  const base = MESSAGES[failure];
  if (failure !== "unknown") return base;
  const name = errorName(error);
  return name ? `${base} (${name})` : base;
}
