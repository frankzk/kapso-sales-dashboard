import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lo que pasa mientras la venta por teléfono trabaja.
 *
 * EL CASO REAL. Se creó un lead desde «Venta por teléfono» y hubo que pulsar el
 * botón azul varias veces: la gaveta apareció a los cinco segundos. El botón no
 * decía nada y la tarjeta se cerraba al instante, así que la pantalla quedaba
 * idéntica a la de antes del clic. Nadie espera cinco segundos frente a algo que
 * parece no haber pasado — vuelve a pulsar.
 *
 * DE DÓNDE SALÍAN LOS CINCO SEGUNDOS. La versión anterior navegaba con
 * `router.push("/dashboard/leads?open=<id>")`, y esa navegación obliga al
 * servidor a rehacer la página entera —los ~2.500 leads de la cola, los siete
 * conteos y los gráficos— antes de pintar nada. La gaveta no necesita nada de
 * eso: solo el detalle de UN lead.
 *
 * Estas pruebas leen el código porque el entorno de pruebas es `node`, sin DOM.
 * Miran lo que decide el comportamiento —a quién se llama, en qué orden y qué
 * dice el botón— y no el aspecto.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const venta = () => read("components/venta-telefonica.tsx");

/** El cuerpo de una función `const nombre = async () => {` hasta su cierre. */
function cuerpo(source: string, decl: string): string {
  const start = source.indexOf(decl);
  expect(start, `no se encontró ${decl}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  };", start);
  return source.slice(start, end);
}

describe("abrir la ficha no pasa por una recarga de toda la cola", () => {
  it("no navega: llama a la gaveta directamente", () => {
    // `router.push` aquí era el coste entero. Se conserva `router.refresh()`,
    // pero DESPUÉS de abrir, donde ya no lo espera nadie.
    // Se busca dentro de `abrir` y no en el archivo: el comentario de cabecera
    // nombra `router.push` para explicar por qué ya no está, y esa explicación
    // hacía fallar la prueba.
    const body = cuerpo(venta(), "const abrir = async () => {");
    expect(body).not.toContain("router.push");
    expect(body).toContain("await onAbrir(");
  });

  it("y el refresco de la lista va después de abrir, no antes", () => {
    const body = cuerpo(venta(), "const abrir = async () => {");
    expect(body.indexOf("await onAbrir(")).toBeLessThan(body.indexOf("router.refresh()"));
  });

  it("la cola expone abrir por id, con fila o sin ella", () => {
    // La venta por teléfono acaba de crear el lead: no tiene su fila, y la lista
    // cargada tampoco. Antes eso se resolvía navegando y confiando en que el
    // lead cayera en la vista; si no caía, no se abría nada y en silencio.
    const leads = read("components/leads.tsx");
    expect(leads).toContain("async function abrirLeadPorId(");
    expect(leads).toContain("previa?: LeadRow | null): Promise<boolean>");
    expect(leads).toContain("onAbrir={(leadId) => abrirLeadPorId(leadId)}");
  });
});

describe("mientras trabaja, lo dice", () => {
  it("el botón cambia de texto y se apaga", () => {
    const source = venta();
    expect(source).toContain("Abriendo la ficha…");
    expect(source).toContain("disabled={abriendo || !phone.trim() || !storeId}");
    expect(source).toContain("aria-busy={abriendo}");
  });

  it("consultar el teléfono tiene su propia espera, con su propio cartel", () => {
    // Un solo `busy` para las dos esperas apagaba el botón azul mientras se
    // consultaba el teléfono, sin decir por qué: el botón se veía muerto justo
    // cuando el usuario quería pulsarlo.
    const source = venta();
    expect(source).toContain("const [consultando, setConsultando] = useState(false)");
    expect(source).toContain("const [abriendo, setAbriendo] = useState(false)");
    expect(source).toContain("Consultando…");
  });

  it("la tarjeta NO se cierra hasta que la gaveta está abierta", () => {
    // Cerrarla antes es lo que dejaba la pantalla igual que antes del clic.
    const body = cuerpo(venta(), "const abrir = async () => {");
    expect(body.indexOf("await onAbrir(")).toBeLessThan(body.indexOf("cerrar()"));
  });

  it("si abrir falla, la tarjeta se queda con lo escrito", () => {
    // El teléfono ya tecleado es trabajo del usuario; perderlo por un error de
    // red obliga a repetirlo con el cliente esperando al teléfono.
    const body = cuerpo(venta(), "const abrir = async () => {");
    expect(body).toContain("if (!(await onAbrir(r.leadId))) return;");
  });
});

describe("dos clics no crean dos leads", () => {
  it("el candado está en un ref, no en el estado", () => {
    // `disabled` solo existe tras el re-render: dos clics en el mismo fotograma
    // leerían `abriendo` todavía en false. Un ref cierra la puerta en el acto.
    const body = cuerpo(venta(), "const abrir = async () => {");
    expect(body).toContain("if (abriendoRef.current) return;");
    expect(body.indexOf("abriendoRef.current = true")).toBeLessThan(
      body.indexOf("await abrirClienteParaVenta("),
    );
  });

  it("y una consulta vieja no pisa el aviso de la nueva", () => {
    // Corregir el número mientras viaja la consulta anterior traía el aviso de
    // OTRO cliente. Un aviso de duplicado equivocado es peor que ninguno.
    const body = cuerpo(venta(), "const consultar = async () => {");
    expect(body).toContain("const token = ++consultaRef.current;");
    expect(body).toContain("if (consultaRef.current === token) setRes(r);");
  });
});
