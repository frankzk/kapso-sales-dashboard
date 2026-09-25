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
// El reenvío de una anulada vive en lib/swayp-reenvio.ts desde que lo comparte
// el agente de voz (MOM §11.8). Las dos fuentes se leen juntas: un camino nuevo
// en cualquiera de las dos tiene que aparecer clasificado abajo.
const REENVIO = "lib/swayp-reenvio.ts";
const source =
  readFileSync(resolve(process.cwd(), ACTIONS), "utf8") + "\n" + readFileSync(resolve(process.cwd(), REENVIO), "utf8");

/** El cuerpo de una función exportada, hasta su llave de cierre en columna 0. */
function cuerpoDe(nombre: string): string {
  const start = source.indexOf(`export async function ${nombre}(`);
  expect(start, `no se encontró ${nombre}`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start));
}

const CREAN_GUIA = ["registerRerouteCall", "reenviarGuiaAnulada"];

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

    /**
     * REGLA NUEVA (16-09-2026). Antes esta prueba exigía lo CONTRARIO: que no
     * conseguir número de Swayp cayera al código local, porque «dejar a la
     * operadora bloqueada porque un courier no responde sería peor». La
     * operación decidió que es al revés. Ese código local —`#KP13166415092026`,
     * el pedido más la fecha— Swayp no lo conoce: no sale en su panel, no
     * descuenta su stock y no rastrea. Una guía así es una caja despachada
     * contra un número que no existe para el courier que la lleva.
     *
     * Con las once bodegas configuradas, la API puede emitir en toda la
     * cobertura, así que el respaldo dejó de pagar lo que costaba.
     */
    it(`${fn} NO cae al código local: sin número de Swayp no hay guía`, () => {
      const body = cuerpoDe(fn);
      expect(body).not.toContain("rescheduleGuideCode(");
      expect(body).toContain("Swayp no emitió la guía:");
    });

    it(`${fn} nombra el motivo que dio Swayp, en vez de enterrarlo en un aviso`, () => {
      // El motivo era lo único que se perdía al caer al código local: quedaba
      // en una frase al final que nadie relacionaba con nada.
      expect(cuerpoDe(fn)).toContain("${viaApi.reason}");
    });
  }

  it("el botón de Envíos y el agente de voz reenvían por el MISMO camino", () => {
    // Dos puertas y una sola reja: si el agente tuviera su propia copia, el día
    // que cambie una regla de stock o de vínculo se desincronizarían.
    expect(cuerpoDe("reprogramCancelledShipmentException")).toContain("reenviarGuiaAnulada(");
    const voz = readFileSync(resolve(process.cwd(), "lib/voice-recovery-server.ts"), "utf8");
    const agente = voz.slice(voz.indexOf("export async function crearSalidaSwaypDelAgente("));
    expect(agente).toContain("await reenviarGuiaAnulada(");
    expect(agente).not.toContain("createGuide(");
  });

  it("el camino MANUAL no pide número, y es correcto", () => {
    // `createFenixGuide` recibe el código que el operador ESCRIBIÓ porque ya
    // generó esa guía en el panel de Swayp. Pedir otro crearía un segundo
    // paquete. Es la misma regla que el alta directa: si hay código a mano, no
    // se llama a la API.
    expect(cuerpoDe("createFenixGuide")).not.toContain("swaypGuideForReprogram(");
  });

  it("pero el camino manual exige que ese número SEA de Swayp", () => {
    // Aceptaba también el que «Autogenerar» acuñaba con el pedido y la fecha,
    // que es exactamente el número que esta regla viene a prohibir.
    const body = cuerpoDe("createFenixGuide");
    expect(body).toContain("esNumeroDeGuiaSwayp(escrito)");
    expect(body).toContain("swaypGuide: escrito");
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
