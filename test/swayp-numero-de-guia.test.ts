import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { esNumeroDeGuiaSwayp } from "@/lib/swayp-guide";
import { rescheduleGuideCode } from "@/lib/shipments";

/**
 * EL NÚMERO DE GUÍA LO EMITE SWAYP. SIN SU NÚMERO NO HAY GUÍA (16-09-2026).
 *
 * Convivían dos familias: la guía Swayp (`50000132589`, que emite su API) y el
 * código Kapta (`#KP13166415092026`, que acuñábamos con el pedido y la fecha).
 * El segundo era el respaldo cuando la API no emitía, y se cargaba después a
 * mano por el Excel. Un número así no sale en el panel de Swayp, no descuenta su
 * stock y no rastrea.
 */

describe("esNumeroDeGuiaSwayp separa las dos familias", () => {
  it("acepta los números que emite Swayp", () => {
    for (const n of ["50000132589", "50000118486", "50000131790"]) {
      expect(esNumeroDeGuiaSwayp(n)).toBe(true);
    }
  });

  it("rechaza los códigos que acuñábamos nosotros", () => {
    for (const n of ["#KP13166415092026", "#AUR17683015092026", "KP11602407072026"]) {
      expect(esNumeroDeGuiaSwayp(n)).toBe(false);
    }
  });

  it("y rechaza lo que acuña la función de la casa, sea cual sea el pedido", () => {
    // Atado a la fuente y no a una cadena escrita a mano: si mañana cambia el
    // formato del código Kapta, esta prueba sigue cubriendo el caso real.
    const kapta = rescheduleGuideCode("#KP131664", "2026-09-15T00:00:00.000Z");
    expect(kapta).toBeTruthy();
    expect(esNumeroDeGuiaSwayp(kapta)).toBe(false);
  });

  it("no se deja engañar por espacios ni por vacío", () => {
    expect(esNumeroDeGuiaSwayp(" 50000132589 ")).toBe(true);
    expect(esNumeroDeGuiaSwayp("")).toBe(false);
    expect(esNumeroDeGuiaSwayp(null)).toBe(false);
    expect(esNumeroDeGuiaSwayp(undefined)).toBe(false);
  });

  it("un número demasiado corto no es una guía", () => {
    expect(esNumeroDeGuiaSwayp("12345")).toBe(false);
    expect(esNumeroDeGuiaSwayp("123456")).toBe(true);
  });
});

describe("las cuatro puertas exigen el número de Swayp", () => {
  const server = readFileSync(resolve(process.cwd(), "app/dashboard/envios/actions.ts"), "utf8");

  it("la guía directa no crea nada si Swayp no emitió", () => {
    expect(server).toContain("Swayp no emitió la guía: ${viaApi.reason}. No se creó ninguna salida.");
  });

  it("la reprogramación y el reenvío tampoco", () => {
    expect(server).toContain("La reprogramación no se registró.");
    expect(server).toContain("El reenvío no se registró.");
  });

  it("y el alta a mano exige que el número sea de Swayp", () => {
    expect(server).toContain("esNumeroDeGuiaSwayp(escrito)");
  });

  it("no queda ni un acuñado de código Kapta en los caminos de Swayp", () => {
    const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
    const modal = readFileSync(
      resolve(process.cwd(), "components/direct-fenix-guide-modal.tsx"),
      "utf8",
    );
    for (const src of [server, ui, modal]) {
      expect(src).not.toMatch(/^\s*(?!\/\/|\s\*).*rescheduleGuideCode\(/m);
    }
  });
});

describe("el MOM fija los dos nombres", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("guía Swayp y código Kapta, y «manual» queda para otra cosa", () => {
    expect(mom).toContain("**guía Swayp** la que emite");
    expect(mom).toContain("**código Kapta** la que acuñábamos nosotros");
    expect(mom).toContain('No se usa «manual»');
  });

  it("y dice que sin número de Swayp no hay guía", () => {
    expect(mom).toContain("El número de guía lo emite Swayp. Sin su número no hay guía");
    expect(mom).toContain("**Ese respaldo se retira.**");
  });
});
