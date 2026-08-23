import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatPeruMobile,
  normalizePhone,
  peruMobileDigits,
  peruMobileProblem,
} from "@/lib/phone";

/**
 * El celular del cliente en el formulario que genera el pedido.
 *
 * QUÉ PASÓ. El campo era libre y lo tecleado viajaba crudo hasta `toE164`, que
 * solo quita lo que no es dígito y antepone `+`. Unos 9 dígitos sueltos —la
 * forma natural de escribir un celular peruano— se convertían en `+988805509`,
 * SIN código de país. Shopify lo rechaza, y el reintento creaba el pedido sin
 * teléfono sin decírselo a nadie: la asesora juraba haberlo escrito, y tenía
 * razón (#KP129725).
 *
 * La regla vive en `lib/phone.ts` y la usan LOS DOS lados —el formulario para
 * bloquear el botón, la server action para no fiarse del formulario—. Estas
 * pruebas son de esa regla; el guardián de que ambos la usan está al final.
 */

describe("peruMobileDigits: sacar los 9 dígitos de lo que sea", () => {
  it("acepta las cuatro formas que aparecen de verdad", () => {
    for (const escrito of ["988805509", "988-805-509", "+51 988 805 509", "51988805509"]) {
      expect(peruMobileDigits(escrito), escrito).toBe("988805509");
    }
  });

  it("el prefijo 00 internacional también se cae", () => {
    expect(peruMobileDigits("0051988805509")).toBe("988805509");
  });

  it("un número que EMPIEZA por 51 sin ser código de país no pierde cifras", () => {
    // `519880550` son 9 dígitos y empieza por 51: quitar el "51" a ciegas lo
    // dejaría en 7 y el mensaje de error hablaría de un número que nadie tecleó.
    expect(peruMobileDigits("519880550")).toBe("519880550");
  });

  it("vacío o basura devuelve cadena vacía, no lanza", () => {
    for (const v of [null, undefined, "", "   ", "abc"]) {
      expect(peruMobileDigits(v)).toBe("");
    }
  });
});

describe("peruMobileProblem: por qué no se puede usar", () => {
  it("un móvil peruano bien escrito no tiene problema", () => {
    for (const escrito of ["988805509", "988-805-509", "+51 988 805 509", "51988805509"]) {
      expect(peruMobileProblem(escrito), escrito).toBeNull();
    }
  });

  it("dice CUÁNTOS dígitos faltan, no «teléfono inválido»", () => {
    // "Faltan 2 dígitos" es accionable delante del cliente; "inválido" obliga a
    // contar a mano, que es justo lo que la máscara vino a evitar.
    expect(peruMobileProblem("9888055")).toContain("Faltan 2");
    expect(peruMobileProblem("98880550")).toContain("Faltan 1 dígito");
    expect(peruMobileProblem("98880550")).not.toContain("dígitos");
  });

  it("también avisa si sobran", () => {
    expect(peruMobileProblem("9888055099")).toContain("Sobra");
  });

  it("un fijo no pasa: por ahí no llega la confirmación de WhatsApp", () => {
    // El mismo formulario ofrece mandar la confirmación por WhatsApp, y el
    // courier llama a ese número. Un fijo de Lima rompe las dos cosas.
    expect(peruMobileProblem("012345678")).toContain("empieza por 9");
  });

  it("vacío pide el número en vez de contar dígitos", () => {
    expect(peruMobileProblem("")).toBe("Escribe el celular del cliente.");
  });
});

describe("formatPeruMobile: que un dígito de menos se VEA", () => {
  it("parte en tres grupos de tres", () => {
    expect(formatPeruMobile("988805509")).toBe("988-805-509");
  });

  it("formatea lo incompleto, porque se aplica mientras se teclea", () => {
    expect(formatPeruMobile("9")).toBe("9");
    expect(formatPeruMobile("9888")).toBe("988-8");
    expect(formatPeruMobile("988805")).toBe("988-805");
  });

  it("desnuda el 51 del prefill: el campo ya pinta el +51 al lado", () => {
    // Sin esto el usuario vería "+51 519-888-055-09" — un dígito de más al ojo y
    // una confusión garantizada sobre si hay que escribir el código de país.
    expect(formatPeruMobile("51988805509")).toBe("988-805-509");
  });

  it("nunca deja escribir más de nueve", () => {
    expect(formatPeruMobile("98880550999999")).toBe("988-805-509");
  });
});

describe("lo que sale hacia Shopify", () => {
  it("las cuatro formas acaban en el mismo número con código de país", () => {
    // ESTA es la regresión: `toE164` (lib/shopify.ts) solo quita lo que no es
    // dígito y antepone `+`. Sin normalizar antes, "988805509" salía como
    // "+988805509" y Shopify lo rechazaba.
    for (const escrito of ["988805509", "988-805-509", "+51 988 805 509", "51988805509"]) {
      expect(normalizePhone(escrito), escrito).toBe("51988805509");
    }
  });
});

describe("la regla es UNA, y los dos lados la usan", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("el formulario bloquea con la regla compartida, no con una suya", () => {
    const source = read("components/leads-drawer.tsx");
    expect(source).toContain('from "@/lib/phone"');
    expect(source).toContain("peruMobileProblem(phone)");
    // Y el botón depende de ella: validar sin bloquear es decorar.
    expect(source).toMatch(/!phoneProblem/);
  });

  it("la server action NO se fía del formulario", () => {
    // Es un server action: se puede invocar sin pasar por esa pantalla. Y el
    // camino de caer al teléfono del lead no pasa por el formulario nunca.
    const source = read("app/dashboard/leads/actions.ts");
    expect(source).toContain("peruMobileProblem(input.phone)");
    expect(source).toMatch(/const phone = normalizePhone\(/);
  });

  it("si Shopify rechaza el número, el aviso lo dice", () => {
    // Callarlo es lo que hizo que nadie se enterara. El pedido se crea igual
    // —una venta no se cae por un teléfono— pero deja de ser un secreto.
    const source = read("app/dashboard/leads/actions.ts");
    expect(source).toContain("phoneRejected");
    expect(source).toMatch(/RECHAZÓ el celular/);
  });
});
