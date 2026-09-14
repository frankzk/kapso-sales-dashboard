// La firma de Flow.cl: HMAC-SHA256 sobre los parámetros ordenados.
//
// EL ALGORITMO. Se ordenan los parámetros alfabéticamente por NOMBRE, se
// concatenan `nombre` + `valor` sin separador ninguno, y se firma ese string
// con HMAC-SHA256 usando el secretKey. La firma viaja en el parámetro `s`,
// que es el único que NO entra en el cálculo.
//
//     {apiKey: "XXXX-XXXX-XXXX", currency: "CLP", amount: 5000}
//     → "amount5000apiKeyXXXX-XXXX-XXXXcurrencyCLP"
//
// VALIDADO CONTRA LA API REAL (12-09-2026), no solo contra el ejemplo del
// manual: Flow verifica el HMAC en cuanto encuentra la apiKey, así que una
// respuesta «Transaction not found» —en vez de un error de firma— demuestra
// que el firmado le cuadró. Ese fue el resultado de `scripts/flow-probe.mjs`.
//
// LAS DOS FORMAS DE ROMPERLO, las dos silenciosas:
//
//  1. MANDAR UN PARÁMETRO QUE NO SE FIRMÓ. Cualquier opcional que se envíe
//     —`timeout`, `paymentMethod`, `currency`— entra en la firma. Si se manda
//     y no se firma, Flow responde 401 sin decir por qué. Por eso acá NO hay
//     una función que firme y otra que arme el cuerpo: `flowSignedPairs`
//     produce los pares que se firman Y los que se envían, y el cliente no
//     tiene forma de mandar nada que no haya pasado por aquí.
//
//  2. FIRMAR UN VALOR DISTINTO DEL QUE VIAJA. Lo que se firma es siempre
//     `String(valor)`, exactamente el mismo string que acaba en el cuerpo
//     `x-www-form-urlencoded`. Si un día alguien formatea el monto al enviarlo
//     pero no al firmarlo, la firma deja de cuadrar y el error tampoco lo dice.

import { createHmac } from "node:crypto";
import type { FlowParams } from "./types";

/**
 * Los pares `[nombre, valor]` tal como se firman y se envían, ordenados.
 *
 * EL ORDEN ES EL DE BYTES, NO EL DEL IDIOMA. El cliente de referencia de Flow
 * es PHP y usa `sort()`, que compara byte a byte; `Array.prototype.sort()` sin
 * comparador hace lo mismo sobre ASCII. Usar `localeCompare` parecería más
 * correcto y rompería la firma en cuanto dos nombres se separen solo por
 * mayúsculas o por un guion bajo —«paymentMethod» y «payment_currency» quedan
 * en distinto orden según quién compare—.
 */
export function flowSignedPairs(params: FlowParams): [string, string][] {
  for (const [name, value] of Object.entries(params)) {
    // `s` es la firma: incluirla en su propio cálculo da un 401 mudo.
    if (name === "s") {
      throw new Error("No se firma el parámetro `s`: es la firma misma.");
    }
    // `undefined` y `null` se colarían como los strings "undefined" y "null",
    // que es peor que faltar: la petición sale, Flow la rechaza y el mensaje
    // habla del valor, no de que el parámetro nunca debió enviarse.
    if (value === undefined || value === null) {
      throw new Error(`El parámetro \`${name}\` no tiene valor y no puede firmarse.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`El parámetro \`${name}\` no es un número finito.`);
    }
  }

  return Object.keys(params)
    .sort()
    .map((name) => [name, String(params[name])]);
}

/** El string que se firma. Expuesto para poder probarlo contra el manual. */
export function flowStringToSign(params: FlowParams): string {
  return flowSignedPairs(params)
    .map(([name, value]) => name + value)
    .join("");
}

/** La firma que va en el parámetro `s`. */
export function signFlowParams(params: FlowParams, secretKey: string): string {
  if (!secretKey) {
    throw new Error("Falta el secretKey de Flow: sin él no se puede firmar.");
  }
  return createHmac("sha256", secretKey).update(flowStringToSign(params)).digest("hex");
}

/**
 * Los parámetros listos para el cable: los firmados, en orden, más `s`.
 *
 * Es lo único que el cliente manda. Que devuelva pares y no un objeto es a
 * propósito: un objeto invita a añadirle una clave más justo antes de enviar,
 * y esa clave viajaría sin firmar.
 */
export function flowRequestPairs(params: FlowParams, secretKey: string): [string, string][] {
  return [...flowSignedPairs(params), ["s", signFlowParams(params, secretKey)]];
}
