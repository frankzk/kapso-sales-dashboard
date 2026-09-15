import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LOS CAMINOS QUE CREAN UNA GUÍA SWAYP PIDEN EL NÚMERO A SWAYP. TODOS.
 *
 * EL CASO REAL. Al conectar la API (#512) se cableó `registerRerouteCall` —la
 * reprogramación de un envío PENDIENTE— y se quedó fuera
 * `reprogramCancelledShipmentException`, que es el «Reenviar por Swayp» de una
 * guía anulada o devuelta. Nadie lo notó durante semanas: la pantalla ofrecía el
 * botón igual y la guía salía con código local, que es lo que salía antes, así
 * que no parecía roto. Se descubrió porque alguien preguntó «¿esto va a generar
 * una guía por el API?» mirando el campo del número ya relleno.
 *
 * Es la forma de fallo más cara de este repo: no un error, sino una vía que
 * nunca se enteró de una regla nueva. Este test la hace visible — si mañana
 * aparece un tercer camino que llama a `spinOffFenixGuide` sin pasar por
 * `swaypGuideForReprogram`, falla acá y no en producción seis semanas después.
 */
const ACTIONS = "app/dashboard/envios/actions.ts";
const source = readFileSync(resolve(process.cwd(), ACTIONS), "utf8");

/** El cuerpo de una función exportada, hasta su llave de cierre en columna 0. */
function cuerpoDe(nombre: string): string {
  const start = source.indexOf(`export async function ${nombre}(`);
  expect(start, `no se encontró ${nombre}`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start));
}

const CREAN_GUIA = ["registerRerouteCall", "reprogramCancelledShipmentException"];

describe("todos los caminos de reprogramación piden el número a Swayp", () => {
  for (const fn of CREAN_GUIA) {
    it(`${fn} llama a swaypGuideForReprogram`, () => {
      expect(cuerpoDe(fn)).toContain("swaypGuideForReprogram(");
    });

    it(`${fn} guarda swaypGuide en la hija`, () => {
      // Sin esto el webhook nunca encuentra la guía: busca por esa columna, no
      // por `guide_code`. El envío se quedaría En ruta para siempre.
      expect(cuerpoDe(fn)).toContain("swaypGuide:");
    });

    it(`${fn} cae al código local en vez de bloquear`, () => {
      // No conseguir número de Swayp no es un error: es seguir por Excel. Dejar
      // a la operadora bloqueada porque un courier no responde sería peor.
      expect(cuerpoDe(fn)).toContain("rescheduleGuideCode(");
    });

    it(`${fn} le dice a la operadora por cuál de los dos caminos salió`, () => {
      const body = cuerpoDe(fn);
      expect(body).toContain("Emitida por Swayp.");
      expect(body).toContain("Swayp no la emitió");
    });
  }

  it("el camino MANUAL no pide número, y es correcto", () => {
    // `createFenixGuide` recibe el código que el operador ESCRIBIÓ porque ya
    // generó esa guía en el panel de Swayp. Pedir otro crearía un segundo
    // paquete. Es la misma regla que el alta directa: si hay código a mano, no
    // se llama a la API.
    expect(cuerpoDe("createFenixGuide")).not.toContain("swaypGuideForReprogram(");
  });

  it("no hay NINGÚN otro camino que cree una guía Swayp", () => {
    // `spinOffFenixGuide` es la única puerta por la que nace una guía Swayp
    // desde otra guía. Cada sitio que la llama tiene que estar clasificado
    // arriba: o pide el número a Swayp, o se documenta por qué no. Un camino
    // nuevo sin clasificar es exactamente cómo se coló el de guías anuladas.
    const declaraciones = [...source.matchAll(/^export async function (\w+)\(/gm)];
    const encontrados = new Set<string>();
    for (const m of source.matchAll(/await spinOffFenixGuide\(/g)) {
      const previa = declaraciones.filter((d) => d.index! < m.index!).pop();
      encontrados.add(previa?.[1] ?? "(sin función)");
    }
    expect([...encontrados].sort()).toEqual([...CREAN_GUIA, "createFenixGuide"].sort());
  });
});
