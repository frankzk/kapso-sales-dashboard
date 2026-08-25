import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyLabel } from "@/components/copy-button";

/**
 * Copiar al portapapeles: una sola forma de hacerlo.
 *
 * EL PROBLEMA QUE ESTO VIGILA. Copiar estaba escrito a mano en cuatro sitios y
 * las cuatro copias habían divergido: «Copiado», «¡Copiado!», «copiado» en
 * minúscula, y tres tiempos de espera distintos. Peor que la estética: dos de
 * las cuatro se tragaban el fallo en silencio y una llegaba a decir «Copiado»
 * cuando el portapapeles había RECHAZADO —quien lo leía se iba a pegar un
 * secreto que no tenía—. Ahora las cuatro llaman al mismo hook.
 *
 * No hay jsdom ni testing-library en el proyecto, así que el hook no se puede
 * montar. Lo que sí se puede comprobar es lo que de verdad se rompía: el texto
 * del acuse (una función pura) y que nadie vuelva a escribirlo a mano.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

describe("el acuse dice la verdad", () => {
  it("un fallo NO se lee como un acierto", () => {
    // Este era el fallo real del webhook de Aliclik: `void writeText(url)` y
    // acto seguido «Copiado», pasara lo que pasara.
    const fail = copyLabel("fail");
    expect(fail).not.toMatch(/^Copiado/);
    expect(fail).toBe("No se pudo copiar");
  });

  it("un fallo tampoco se queda callado", () => {
    // Los otros tres sitios tenían el catch vacío: el botón no reaccionaba y no
    // se distinguía «ya está» de «no se pudo».
    expect(copyLabel("fail")).not.toBe(copyLabel("idle"));
    expect(copyLabel("fail")).not.toBe("Copiar");
  });

  it("las cuatro pantallas dicen lo MISMO al lograrlo, con la etiqueta que sea", () => {
    for (const idle of ["Copiar", "copiar", "Copiar +51999999999", "Copiar pedido"]) {
      expect(copyLabel("ok", idle)).toBe("Copiado");
    }
  });

  it("en reposo cada botón conserva su etiqueta", () => {
    expect(copyLabel("idle")).toBe("Copiar");
    expect(copyLabel("idle", "copiar")).toBe("copiar");
    expect(copyLabel("idle", "Copiar pedido")).toBe("Copiar pedido");
  });
});

describe("nadie lo vuelve a escribir a mano", () => {
  it("solo `copy-button.tsx` toca el portapapeles", () => {
    // Sin esto, la quinta copia entra sin que nadie se entere y vuelve a
    // divergir. La regla no es de estilo: las cuatro que había fallaban en
    // silencio o mentían, cada una a su manera.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith("components/copy-button.tsx")) continue;
      if (/navigator\s*\.\s*clipboard/.test(read(file))) offenders.push(file);
    }
    expect(offenders, "escriben al portapapeles por su cuenta").toEqual([]);
  });

  it("los cuatro sitios llaman al hook", () => {
    for (const file of ["components/store-settings.tsx", "components/leads-drawer.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("useCopyToClipboard()");
      expect(source, file).toContain("copyLabel(");
      // Y ya no guardan su propio acuse: si volviera un `setCopied`, volvería
      // con él el temporizador que nadie cancelaba al desmontar —y un drawer
      // es justo donde copias y cierras—.
      // Con `\b` porque `resetCopiedOrder` LLEVA DENTRO la cadena «setCopied»,
      // y es justo lo contrario de lo que se persigue: baja el acuse usando el
      // hook. Sin el límite de palabra, esta prueba fallaba con el arreglo
      // puesto.
      expect(source, file).not.toMatch(/\bsetCopied/);
    }
  });

  it("el panel de pedido generado baja el acuse con el hook, no por su cuenta", () => {
    // Al cambiar de lead y al volver a generar, lo copiado deja de existir: un
    // «Copiado» heredado se leería como que el pedido NUEVO ya está copiado.
    // `reset` existe por esto; si se cae, el acuse se queda pegado.
    const source = read("components/leads-drawer.tsx");
    expect(source).toContain("reset: resetCopiedOrder");
    expect(source.match(/resetCopiedOrder\(\)/g) ?? [], "los dos sitios que lo vacían").toHaveLength(
      2,
    );
    expect(read("components/copy-button.tsx")).toContain("return { state, copy, reset }");
  });
});

function sourceFiles(): string[] {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync("git", ["ls-files", "app", "components", "lib", "*.ts", "*.tsx"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
}
