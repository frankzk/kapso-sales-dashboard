import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El texto de Envíos dice lo que pasa, con los nombres del MOM.
 *
 * Crítica y audit del 12-09-2026:
 *   * El MOM manda «Swayp (antes Fénix)» y la pantalla decía «Fenix» y «Fénix»
 *     mezclados en unas 40 etiquetas. El código sigue diciendo `fenix`.
 *   * «Ingestión» era jerga de importación para «nadie la ha llamado».
 *   * «Etapa 1» y «Paso 1» eran dos numeraciones en el mismo cajón.
 *   * Descartar la recuperación era terminal, a un clic, con la regla de 8
 *     caracteres escondida en el servidor.
 *   * Las cabeceras de «Hoy por asesora» solo se explicaban por tooltip.
 *   * «Reprogramados en Kapso»: el nombre viejo del producto.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const lib = readFileSync(resolve(process.cwd(), "lib/shipments.ts"), "utf8");
const server = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");

/** Solo lo que ve la persona: cadenas y texto JSX, sin identificadores ni comentarios. */
function visibleText(src: string): string {
  return src
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("Swayp es el nombre vigente", () => {
  it("ninguna etiqueta dice «Fenix» a secas; la primera mención de cada bloque dice «antes Fénix»", () => {
    for (const [name, src] of [["ui", ui], ["lib", lib], ["server", server]] as const) {
      expect(visibleText(src), name).not.toMatch(/\bFenix\b/);
    }
    // El renombre se explica UNA vez, en la nota que ya explica el resto.
    // Estaba incrustado en tres etiquetas de formulario que se leen doscientas
    // veces al día: un aviso de renombre no es parte del nombre de un campo.
    expect(ui).toContain("Guía Swayp a mano");
    expect(ui).toContain("¿Qué informó Swayp?");
    expect(ui).toContain("(antes Fénix; se creó una guía Swayp)");
    expect(ui.match(/antes Fénix/g)?.length).toBe(1);
  });

  it("el código no cambió de nombre", () => {
    expect(ui).toContain('courier === "fenix"');
    expect(ui).toContain("FenixAvailabilityInline");
    expect(server).toContain("export async function createFenixGuide(");
  });
});

describe("palabras de la asesora, no del sistema", () => {
  it("«Sin llamar» en vez de «Ingestión»", () => {
    expect(lib).toContain('if (n <= 0) return "Sin llamar";');
    expect(ui).not.toContain("Ingestión");
  });

  it("una sola forma de nombrar los pasos", () => {
    expect(ui).not.toContain("Etapa 1");
    expect(ui).not.toContain("Paso 1");
    expect(ui).toContain(">Resultado del courier registrado</p>");
    expect(ui).toContain('"Resultado del courier · obligatorio"');
  });

  it("el producto se llama Kapta", () => {
    expect(ui).not.toContain("Kapso");
  });
});

describe("descartar la recuperación se confirma nombrando el pedido", () => {
  it("la regla del mínimo es visible junto al campo, y el segundo paso trae Cancelar", () => {
    // El «8» estaba a mano en cuatro sitios contra `DISCARD_REASON_MIN`, que ya
    // existía y el componente ni importaba: subirlo en `lib/` habría dejado la
    // pantalla diciendo un número y el servidor exigiendo otro.
    expect(ui).toContain('import { DISCARD_REASON_MIN } from "@/lib/recovery-discard";');
    expect(ui).toContain("`Mínimo ${DISCARD_REASON_MIN} caracteres · faltan ${DISCARD_REASON_MIN - recoveryNote.trim().length}`");
    expect(ui).not.toMatch(/trim\(\)\.length < 8\b/);
    expect(ui).toContain('recoveryDisposition === "no_quiere" && confirmDiscard ? (');
    expect(ui).toContain("`Sí, descartar ${detail.shipment.order_name ? `el pedido ${detail.shipment.order_name}` : \"este pedido\"}`");
    expect(ui).toContain('"Descartar la recuperación…"');
    // Cambiar de resultado retira la confirmación pendiente.
    expect(ui).toContain("setRecoveryDisposition(e.target.value as RecoveryCallDisposition);\n                      setConfirmDiscard(false);");
  });
});

describe("lo que explicaba un tooltip ahora se lee", () => {
  it("la tabla de hoy por asesora lleva una leyenda visible y cabeceras sin abreviar", () => {
    const panel = ui.slice(ui.indexOf("Hoy por asesora</span>"), ui.indexOf("function ReprogramStrip"));
    expect(panel).not.toContain('title="');
    expect(panel).toContain(">Reprogramadas</th>");
    expect(panel).toContain("Entregadas: cerradas por el resultado del courier");
    expect(ui).not.toContain('title="Editar nota"');
  });
});
