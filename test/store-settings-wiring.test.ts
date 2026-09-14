import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStoreUpdate } from "@/lib/store-settings";
import { generateEncryptionKey } from "@/lib/crypto";

/**
 * Que un secreto del formulario llegue de verdad a la base.
 *
 * EL CASO, DOS VECES. Guardar un secreto por tienda pasa por TRES sitios que
 * nadie obliga a estar de acuerdo:
 *
 *   1. `components/store-settings.tsx` — el campo que el usuario rellena.
 *   2. `app/dashboard/[storeId]/settings/actions.ts` — que lee el formData
 *      enumerando `get("...")` campo por campo.
 *   3. `lib/store-settings.ts` — que lo cifra y arma el patch.
 *
 * Si falta el paso 2, el formulario envía el valor, el servidor lo tira y la
 * pantalla sigue diciendo «no configurado» SIN NINGÚN ERROR. No hay nada que
 * falle: simplemente no se guarda. Ya pasó con la clave de Anthropic —su
 * comentario sigue en actions.ts— y volvió a pasar con las tres credenciales
 * de Flow.cl, que se cargaron en Kenku Perú y no quedaron.
 *
 * Un fallo mudo que se repite no se arregla arreglándolo: se arregla con algo
 * que lo delate. Esta prueba compara los tres ficheros entre sí.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const FORM = read("components/store-settings.tsx");
const ACTION = read("app/dashboard/[storeId]/settings/actions.ts");

/** Los `name` de cada `<SecretField>` del formulario. */
const camposSecretos: string[] = [
  ...new Set(
    [...FORM.matchAll(/<SecretField\b[^>]*?name="([a-z_0-9]+)"/gs)]
      .map((m) => m[1])
      .filter((n): n is string => Boolean(n)),
  ),
].sort();

describe("los secretos del formulario llegan al servidor", () => {
  it("el formulario tiene campos secretos que revisar", () => {
    // Si esto baja a cero es que el selector dejó de encontrarlos —por un
    // renombre del componente, por ejemplo— y la prueba estaría pasando en
    // vacío, que es peor que fallar.
    expect(camposSecretos.length).toBeGreaterThanOrEqual(14);
    expect(camposSecretos).toContain("flowcl_api_key");
  });

  for (const campo of camposSecretos) {
    it(`\`${campo}\` se lee en la acción de guardado`, () => {
      expect(ACTION).toContain(`get("${campo}")`);
    });
  }
});

describe("y buildStoreUpdate sabe cifrarlos", () => {
  const KEY = generateEncryptionKey();

  for (const campo of camposSecretos) {
    it(`\`${campo}\` produce algo que guardar`, () => {
      // El tercer eslabón: que el patch salga NO vacío al mandar un valor. Sin
      // esto, un campo podría estar en el formulario y en la acción y aun así
      // no tener rama en buildStoreUpdate — y volvería a perderse en silencio.
      const patch = buildStoreUpdate({ [campo]: "valor-de-prueba" }, KEY);
      expect(Object.keys(patch).length).toBeGreaterThan(0);
    });
  }
});
