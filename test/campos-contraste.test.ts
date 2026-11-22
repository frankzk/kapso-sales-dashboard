import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Borde de los campos (22-11-2026). Los campos de texto, selectores y áreas de
 * texto llevaban el anillo `line-strong` (#d5dbe1), a 1,4:1 sobre blanco: un
 * campo vacío no dejaba ver dónde empieza. WCAG 1.4.11 pide 3:1 para el borde
 * que identifica un control, y PRODUCT.md fija WCAG 2.1 AA. Ahora llevan
 * `line-field`; botones, píldoras y separadores siguen en `line-strong`, porque
 * su texto ya los identifica.
 */

const root = process.cwd();
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, "i").exec(css);
  expect(m, name).not.toBeNull();
  return m![1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("el borde de los campos se ve", () => {
  it("line-field llega a 3:1 sobre blanco, el lienzo y wash", () => {
    const field = token("line-field");
    // El lienzo es `slate-50` de Tailwind (oklch(98.4% 0.003 247.858) ≈ #f8fafc).
    for (const ground of ["#ffffff", "#f8fafc", token("wash")]) {
      expect(contrast(field, ground), `${field} sobre ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("FIELD_BOX, la base de todos los campos, usa line-field", () => {
    const src = readFileSync(resolve(root, "components/ops-ui.tsx"), "utf8");
    const box = /export const FIELD_BOX =\s*"([^"]+)"/.exec(src)?.[1] ?? "";
    expect(box).toContain("ring-line-field");
    expect(box).not.toContain("line-strong");
  });

  it("ningún input, select o textarea vuelve a line-strong", () => {
    const offenders: string[] = [];
    for (const dir of ["components", "app"]) {
      for (const file of readdirSync(resolve(root, dir), { recursive: true }) as string[]) {
        if (!file.endsWith(".tsx")) continue;
        const src = readFileSync(resolve(root, dir, file), "utf8");
        for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
          // La etiqueta de apertura entera, saltando lo que va entre llaves.
          let depth = 0;
          let i = m.index! + m[0].length;
          while (i < src.length && (src[i] !== ">" || depth > 0)) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          const tag = src.slice(m.index!, i);
          if (/type="(checkbox|radio)"/.test(tag)) continue;
          if (/\b(ring|border)-line-strong\b/.test(tag)) {
            offenders.push(`${dir}/${file}:${src.slice(0, m.index!).split("\n").length}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
