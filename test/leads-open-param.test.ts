import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `?open=<id>` es una ORDEN, no un estado.
 *
 * EL CASO REAL. Una URL con `?open=` se quedó en la barra, y a partir de ahí
 * cada recarga de Leads reabría la ficha de un lead que ya se había cerrado a
 * propósito. Lo mismo con un enlace guardado y con la vuelta atrás del
 * navegador.
 *
 * Y NO ERA SOLO MOLESTO. Abrir la gaveta llama a `claimLead`: recargar la página
 * volvía a adjudicarle ese lead a quien estuviera mirando. Un parámetro pegado
 * en la URL acababa moviendo a quién le toca atender.
 *
 * LA REGLA. El parámetro se cumple una vez y se borra. Quien lo pone —hoy solo
 * el pop-up de Yapes— manda abrir un lead; no declara que la pantalla deba
 * quedarse abierta en él para siempre.
 *
 * El entorno de pruebas es `node`, sin DOM: estas pruebas leen el código y miran
 * lo que decide el comportamiento —qué se llama y en qué orden—, no el aspecto.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

/** El efecto que consume la orden de la URL. */
function efectoConsumo(): string {
  const source = read("components/leads.tsx");
  const start = source.indexOf("const intencionRef = useRef<string | null>(null);");
  expect(start, "no se encontró el efecto que consume ?open=").toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}, [initialOpenId]);", start));
}

describe("la orden se borra de la URL en cuanto se recoge", () => {
  it("se quita el parámetro, no se deja puesto", () => {
    const body = efectoConsumo();
    expect(body).toContain('sp.delete("open")');
    expect(body).toContain("window.history.replaceState(");
  });

  it("y se quita SIN navegar", () => {
    // `router.replace` es una navegación: rehacer la página entera —los ~2.500
    // leads de la cola, los siete conteos y los gráficos— para limpiar la barra
    // de direcciones costaría segundos a cambio de nada.
    expect(efectoConsumo()).not.toContain("router.replace");
  });

  it("se conserva el resto de la query: la tienda y la vista no son la orden", () => {
    // El pop-up de Yapes navega con `?store=…&view=yape&open=…`. Borrar la query
    // entera dejaría al usuario en otra tienda distinta de la del Yape.
    const body = efectoConsumo();
    expect(body).toContain("new URLSearchParams(window.location.search)");
    expect(body).toContain("qs ? `${window.location.pathname}?${qs}` : window.location.pathname");
  });

  it("la intención se guarda ANTES de limpiar", () => {
    // Un lead recién creado puede no estar todavía en la lista cargada. Si la
    // orden viviera solo en la URL, al borrarla se perdería el reintento.
    const body = efectoConsumo();
    expect(body.indexOf("setPendienteDeAbrir(initialOpenId)")).toBeLessThan(
      body.indexOf('sp.delete("open")'),
    );
  });
});

describe("y se cumple una sola vez", () => {
  it("abrir la ficha consume la orden", () => {
    const source = read("components/leads.tsx");
    const start = source.indexOf("if (!pendienteDeAbrir) return;");
    const body = source.slice(start, source.indexOf("}, [pendienteDeAbrir, leads]);", start));
    expect(body).toContain("setPendienteDeAbrir(null)");
    expect(body).toContain("openLead(lead)");
  });

  it("una orden nueva vuelve a valer, aunque sea del mismo lead", () => {
    // "Tomar" dos veces sobre el mismo Yape tiene que abrirlo las dos veces.
    expect(efectoConsumo()).toContain("intencionRef.current = null;");
  });
});

describe("quién puede dar la orden", () => {
  it("solo el pop-up de Yapes escribe ?open=", () => {
    // La venta por teléfono lo hacía y por eso apareció esta URL pegada; ahora
    // abre la gaveta directamente. Si alguien vuelve a añadir un `?open=` desde
    // otro sitio, que sea una decisión y no un descuido.
    const productores = ["components/yape-alerts.tsx", "components/venta-telefonica.tsx"];
    const conOpen = productores.filter((f) => read(f).includes("&open=${"));
    expect(conOpen).toEqual(["components/yape-alerts.tsx"]);
  });
});
