import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `?open=<id>` es una ORDEN, no un estado. Y se lleva la cuenta de las órdenes
 * cumplidas, no de los leads abiertos.
 *
 * EL CASO REAL, EN DOS ACTOS.
 *
 * PRIMERO: una URL con `?open=` se quedó en la barra y cada recarga de Leads
 * reabría una ficha que ya se había cerrado a propósito. Y no era solo molesto:
 * abrir la gaveta llama a `claimLead`, así que recargar volvía a adjudicarle ese
 * lead a quien estuviera mirando. Se limpió la barra al cumplir la orden.
 *
 * NO BASTÓ. Seguía reabriéndose con la barra ya limpia. Leads se refresca sola
 * cada pocos segundos con `router.refresh()`, y ese refresco vuelve a renderizar
 * desde la URL que el router considera suya, que no siempre es la que enseña el
 * navegador. `initialOpenId` iba y venía —X, null, X— y cada vuelta reabría la
 * ficha; el guardián de entonces, que solo comparaba con el valor anterior, se
 * rearmaba en cada `null` y dejaba pasar la siguiente X.
 *
 * LA REGLA QUE SÍ CIERRA EL CICLO: recordar qué órdenes ya se cumplieron. Da
 * igual por qué camino reaparezca una: si ya se obedeció, no se repite.
 *
 * Y EL SELLO `?oid=` es lo que permite las dos cosas a la vez — «Tomar» dos
 * veces el mismo Yape son dos órdenes distintas y ambas se obedecen; una orden
 * que reaparece sola trae el sello viejo y se ignora.
 *
 * El entorno de pruebas es `node`, sin DOM: estas pruebas leen el código y miran
 * lo que decide el comportamiento —qué se llama y en qué orden—, no el aspecto.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

/** El efecto que consume la orden de la URL. */
function efectoConsumo(): string {
  const source = read("components/leads.tsx");
  const start = source.indexOf("const cumplidasRef = useRef<Set<string>>(new Set());");
  expect(start, "no se encontró el efecto que consume ?open=").toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}, [initialOpenId, initialOpenNonce]);", start));
}

describe("la cuenta es por ORDEN, no por lead", () => {
  it("una orden ya cumplida no se repite, venga por donde venga", () => {
    // Esta es la pieza que corta el ciclo X → null → X del refresco automático.
    const body = efectoConsumo();
    expect(body).toContain('const orden = `${initialOpenId}:${initialOpenNonce ?? ""}`;');
    expect(body).toContain("if (cumplidasRef.current.has(orden)) return;");
    expect(body).toContain("cumplidasRef.current.add(orden);");
  });

  it("y nada rearma la memoria cuando la orden desaparece", () => {
    // El guardián anterior se ponía a cero al ver `initialOpenId` en null, que es
    // justo lo que pasa entre dos refrescos. Ahí nació el rebote.
    const body = efectoConsumo();
    expect(body).toContain("if (!initialOpenId) return;");
    expect(body).not.toContain("cumplidasRef.current.clear()");
    expect(body).not.toContain("cumplidasRef.current = ");
  });

  it("quien da la orden la sella", () => {
    // Sin sello, «Tomar» otra vez el mismo Yape sería indistinguible de una
    // orden resucitada, y habría que elegir cuál de las dos romper.
    expect(read("components/yape-alerts.tsx")).toContain("&oid=${Date.now()}");
  });

  it("el sello llega hasta la cola", () => {
    const page = read("app/dashboard/leads/page.tsx");
    expect(page).toContain('initialOpenNonce={typeof sp.oid === "string" ? sp.oid : null}');
  });
});

describe("la orden se borra de la URL en cuanto se recoge", () => {
  it("se quitan los dos parámetros, no se dejan puestos", () => {
    // Limpiar no basta —de ahí el segundo acto— pero sigue haciendo falta: sin
    // esto, recargar o compartir el enlace arrastra la orden a otra sesión.
    const body = efectoConsumo();
    expect(body).toContain('sp.delete("open")');
    expect(body).toContain('sp.delete("oid")');
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
  it("abrir la ficha consume la orden pendiente", () => {
    const source = read("components/leads.tsx");
    const start = source.indexOf("if (!pendienteDeAbrir) return;");
    const body = source.slice(start, source.indexOf("}, [pendienteDeAbrir, leads]);", start));
    expect(body).toContain("setPendienteDeAbrir(null)");
    expect(body).toContain("openLead(lead)");
  });
});

describe("quién puede dar la orden", () => {
  it("solo el pop-up de Yapes escribe ?open=", () => {
    // La venta por teléfono lo hacía y por eso apareció la primera URL pegada;
    // ahora abre la gaveta directamente. Si alguien vuelve a añadir un `?open=`
    // desde otro sitio, que sea una decisión y no un descuido.
    const productores = ["components/yape-alerts.tsx", "components/venta-telefonica.tsx"];
    const conOpen = productores.filter((f) => read(f).includes("&open=${"));
    expect(conOpen).toEqual(["components/yape-alerts.tsx"]);
  });
});
