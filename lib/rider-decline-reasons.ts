// Motivos cortos de «no lo recojo» (0174, MOM §29.13). Cerrados para poder
// contarlos por motorizado.
//
// Viven fuera de app/reparto/receive.ts a propósito: ese archivo es «use
// server» y Next solo admite que exporte funciones async. Exportar esta lista
// desde ahí no rompía la pantalla del motorizado, pero sí cualquier acción de
// servidor de las rutas que montan RiderReceiveBox o ScanAction (Despacho del
// día, /dashboard/courier): al cargar la acción, Next validaba el módulo,
// encontraba un objeto y respondía 500 —por ejemplo al abrir la ficha del
// pedido desde «Ver actividad».
export const DECLINE_REASONS = [
  { code: "no_esta", label: "No está en la caja" },
  { code: "danado", label: "Está dañado" },
  { code: "no_cabe", label: "No cabe en la moto" },
  { code: "otro", label: "Otro" },
] as const;

export type DeclineReasonCode = (typeof DECLINE_REASONS)[number]["code"];
