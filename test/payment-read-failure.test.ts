import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Una consulta que falla no puede imprimirse como un hecho sobre el dinero.
 *
 * QUÉ PASÓ. En #AUR175525 el comprobante estaba registrado en la base y el
 * drawer decía "Todavía no se ha cargado ningún comprobante" y "S/ 0.00
 * validados de S/ 99.00". Las dos frases salían de `paymentsRes.data ?? []`:
 * cualquier error —permiso, red, PostgREST— se volvía lista vacía, y la lista
 * vacía se lee como "este cliente no pagó". El equipo va detrás del cliente a
 * pedirle un Yape que ya mandó.
 *
 * Es un fallo silencioso de los caros: no hay excepción, no hay log, y la
 * pantalla se ve normal. Por eso se vigila desde el código fuente — el patrón
 * `data ?? []` es una línea que se escribe sin pensar, y lo que hay que impedir
 * es que vuelva a entrar sin su comprobación al lado.
 *
 * Estas pruebas miran el fuente porque las server actions arrastran
 * `next/cache`, `next/headers` y el cliente de Supabase: instanciarlas costaría
 * más andamiaje que el que protege, y el invariante —toda lectura comprobada—
 * es estructural, no de valores.
 */

const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), "utf8");

const ACTIONS = "app/dashboard/pedidos/payment-actions.ts";
const PANEL = "components/pickup-key-panel.tsx";

/** El cuerpo de una función del fichero, hasta la siguiente de primer nivel. */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `no se encontró ${signature}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\nexport (async )?function |\n\/\/ -{20,}/);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("loadPaymentPanel: ninguna lectura se convierte en silencio", () => {
  const panel = bodyOf(read(ACTIONS), "export async function loadPaymentPanel(");

  it("cada consulta del panel tiene su comprobación de error", () => {
    // ESTA es la regresión. Si mañana se añade una quinta lectura y se olvida
    // la comprobación, los dos números dejan de cuadrar y este test cae. Contar
    // es lo único que sirve: comprobar "alguna" comprobación dejaría pasar la
    // nueva.
    const lecturas = panel.match(/\bsb\s*\.?\s*\n?\s*\.from\(/g) ?? [];
    const comprobaciones = panel.match(/error:\s*\w+Res\.error/g) ?? [];
    expect(lecturas.length).toBeGreaterThan(0);
    expect(comprobaciones.length).toBe(lecturas.length);
  });

  it("el error se mira ANTES de coercionar los datos a lista vacía", () => {
    // Comprobar después del `?? []` no arregla nada: para entonces la lista
    // vacía ya existe y el único camino que queda es imprimirla.
    const guardia = panel.indexOf("reads.find");
    const coercion = panel.indexOf("paymentsRes.data ??");
    expect(guardia).toBeGreaterThanOrEqual(0);
    expect(coercion).toBeGreaterThan(guardia);
  });

  it("devuelve el error hacia arriba en vez de tragárselo", () => {
    expect(panel).toMatch(/if \(failed\?\.error\) return \{ error:/);
  });

  it("no vuelve a pedir la clave de recojo con el cliente del usuario", () => {
    // `authenticated` no tiene ni policy (0049) ni privilegio (0053) sobre
    // `shalom_pickup_keys`: esa consulta solo podía devolver error. Se pedía y
    // se descartaba con `void keyRes` — un viaje garantizado a fallar en cada
    // apertura del panel, y el ruido que más cuesta cuando por fin miras los
    // errores buscando uno de verdad.
    expect(panel).not.toContain('sb.from("shalom_pickup_keys")');
    // La existencia sí se consulta, pero con el service role y sin exponer nada
    // más que un booleano.
    expect(panel).toMatch(/admin[\s\S]{0,80}shalom_pickup_keys[\s\S]{0,120}select\("order_id"\)/);
  });
});

describe("registerPayment: una lectura caída no puede abrir la puerta", () => {
  const register = bodyOf(read(ACTIONS), "export async function registerPayment(");

  it("aborta si no pudo leer los pagos que ya tenía el pedido", () => {
    // Sin esto el error deja `existingAmount` en 0 y `liveKinds` vacío:
    // `paymentPlanProblem` ve un pedido virgen y deja entrar un segundo
    // adelanto, o un "total" encima de lo ya cobrado.
    expect(register).toContain("currentPaymentsError");
    expect(register).toMatch(/if \(currentPaymentsError\) \{\s*\n\s*return \{/);
  });

  it("las tres búsquedas de duplicado pasan por el mismo recolector de errores", () => {
    // Antes cada una destructuraba solo `data`. Con una caída, `existing` queda
    // corta y `findDuplicate` responde "no hay duplicado" por falta de datos en
    // vez de por hecho comprobado.
    const busquedas = register.match(/push\(await admin/g) ?? [];
    expect(busquedas.length).toBe(3);
    expect(register).not.toMatch(/push\(data\)/);
    expect(register).toMatch(/if \(res\.error\)/);
  });

  it("el veredicto de duplicado no se emite sobre datos incompletos", () => {
    // El orden es el fondo del asunto: comprobar los fallos después de
    // `findDuplicate` sería decorativo, porque la decisión ya estaría tomada.
    const guardia = register.indexOf("lookupErrors.length");
    const veredicto = register.indexOf("findDuplicate(");
    expect(guardia).toBeGreaterThanOrEqual(0);
    expect(veredicto).toBeGreaterThan(guardia);
  });
});

describe("el panel enseña el fallo, no un panel vacío", () => {
  const source = read(PANEL);

  it("los dos paneles cargan por el mismo sitio", () => {
    // Estaban copiados letra por letra, así que el arreglo se habría quedado en
    // uno de los dos. Una sola llamada a la server action garantiza que no.
    expect((source.match(/usePaymentPanel\(orderId\)/g) ?? []).length).toBe(2);
    expect((source.match(/loadPaymentPanel\(orderId\)/g) ?? []).length).toBe(1);
  });

  it("una server action que ni siquiera llega deja de colgar la pantalla", () => {
    // Sin `catch`, la promesa rechazada dejaba `panel` en null y `error` en
    // null: "Cargando pagos…" para siempre, sin motivo y sin reintento.
    expect(bodyOf(source, "function usePaymentPanel(")).toContain("catch");
  });

  it("los dos ofrecen reintentar en vez de quedarse en «Cargando…»", () => {
    expect((source.match(/<PanelLoadError/g) ?? []).length).toBe(2);
    // El botón es lo que convierte un callejón sin salida en un reintento.
    expect(source).toContain("Intentar nuevamente");
  });

  it("el motivo del fallo llega a la pantalla", () => {
    // El `return` de "Cargando…" iba por delante del sitio donde se pinta el
    // error, así que "Sin acceso a este pedido." no se leyó nunca.
    expect((source.match(/if \(error\) return <PanelLoadError|if \(error\) \{/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });
});
