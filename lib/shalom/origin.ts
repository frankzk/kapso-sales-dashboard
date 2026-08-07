/**
 * De qué vía nació una salida de Shalom. Es el valor que va a
 * `shipments.created_via`.
 *
 * Las dos vías viven en el drawer del Master y las dos las dispara una persona
 * identificada; lo que las separa es QUIÉN emitió la guía. Importa distinguirlas
 * porque solo una puede fallar del lado de Shalom —y dejar una guía cobrada sin
 * fila acá— y porque la de contingencia entra con los identificadores que el
 * operador alcanzó a copiar, que pueden venir incompletos.
 *
 * Existe como módulo propio y no como literales sueltos porque durante las
 * primeras 185 guías el insert de la vía API no escribía `created_via` y el de
 * contingencia sí: la columna decía «origen técnico de la salida» y en Shalom
 * no distinguía nada, porque el caso frecuente era justo el que faltaba.
 */
export const SHALOM_ORIGIN = {
  /** `POST /v1/orders`: la guía la emite la integración. El caso normal. */
  api: "shalom_pro_api",
  /** La guía ya existía en pro.shalom.pe y el operador la copia a mano. */
  manual: "shalom_pro_manual",
} as const;

export type ShalomOrigin = (typeof SHALOM_ORIGIN)[keyof typeof SHALOM_ORIGIN];
