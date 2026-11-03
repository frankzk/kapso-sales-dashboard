// Tanders ya no crea guías nuevas (26-10-2026, decisión del owner, MOM §9
// «Aliclik en Lima»). En Lima, su lugar lo toma Aliclik con AUTOECOM.
//
// Solo se apaga CREAR. Las guías de Tanders que ya existen siguen como hasta
// hoy: su estado, sus cobros, sus devoluciones y su liquidación. Volver a
// encenderlo es poner esto en `true` (y devolver Tanders al plan de rutas de
// Lima, lib/order-route-plan.ts).
export const TANDERS_NEW_GUIDES_ENABLED: boolean = false;

export const TANDERS_NEW_GUIDES_OFF_MESSAGE =
  "Tanders ya no crea guías nuevas (desde el 26-10-2026). En Lima el pedido sale por Grupo GF, Aliclik (AUTOECOM) o Swayp.";
