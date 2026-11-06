// Guardia de `pnpm-lock.yaml` contra `package.json`.
//
// POR QUÉ EXISTE ESTE TEST. Vercel instala con `pnpm install --frozen-lockfile`:
// si `package.json` pide una dependencia que el lockfile no tiene, o con otro
// specifier, la instalación falla y el despliegue de producción se queda en el
// commit anterior. Pasó el 06-11-2026: `jssip` entró en package.json (y en
// package-lock.json) pero no en pnpm-lock.yaml. `npm install` y vitest no lo
// ven, porque usan package-lock.json; esto sí.
//
// Lee `importers['.']` del lockfile con un lector mínimo (sin dependencias
// nuevas): las secciones `dependencies`, `devDependencies` y
// `optionalDependencies`, y de cada paquete su `specifier`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type Section = (typeof SECTIONS)[number];
type Specifiers = Record<Section, Record<string, string>>;

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
};

/** Los specifiers de `importers['.']` de un pnpm-lock.yaml (v6 a v9). */
function lockImporterSpecifiers(yaml: string): Specifiers {
  const out: Specifiers = { dependencies: {}, devDependencies: {}, optionalDependencies: {} };
  const lines = yaml.split(/\r?\n/);
  let i = lines.findIndex((l) => l === "importers:");
  if (i < 0) throw new Error("pnpm-lock.yaml sin «importers:»");
  // El bloque `  .:` dentro de importers.
  for (i += 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^\S/.test(l)) throw new Error("pnpm-lock.yaml sin importers['.']");
    if (/^ {2}(\.|'\.'|"\."):\s*$/.test(l)) break;
  }
  let section: Section | null = null;
  let pkg: string | null = null;
  for (i += 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    if (indent <= 2) break; // otro importer, u otra clave de arriba
    if (indent === 4) {
      const name = l.trim().replace(/:\s*$/, "");
      section = (SECTIONS as readonly string[]).includes(name) ? (name as Section) : null;
      pkg = null;
      continue;
    }
    if (!section) continue;
    if (indent === 6 && /:\s*$/.test(l)) {
      pkg = unquote(l.trim().replace(/:\s*$/, ""));
      continue;
    }
    const m = /^ {8}specifier:\s*(.+)$/.exec(l);
    if (m && pkg) out[section][pkg] = unquote(m[1]!);
  }
  return out;
}

const pkgJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as Partial<Record<Section, Record<string, string>>>;
const lock = lockImporterSpecifiers(readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8"));

describe("pnpm-lock.yaml está al día con package.json (Vercel: --frozen-lockfile)", () => {
  it("el lector entiende el formato del lockfile", () => {
    const sample = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      '@scope/a':",
      "        specifier: ^1.2.3",
      "        version: 1.2.4",
      "      b:",
      "        specifier: '>=2'",
      "        version: 2.0.0(react@19.2.7)",
      "    devDependencies:",
      "      c:",
      "        specifier: 3.0.0",
      "        version: 3.0.0",
      "",
      "  packages/otro:",
      "    dependencies:",
      "      d:",
      "        specifier: 1.0.0",
      "",
      "packages:",
      "",
      "  '@scope/a@1.2.4':",
      "    resolution: {integrity: sha512-x}",
    ].join("\n");
    expect(lockImporterSpecifiers(sample)).toEqual({
      dependencies: { "@scope/a": "^1.2.3", b: ">=2" },
      devDependencies: { c: "3.0.0" },
      optionalDependencies: {},
    });
  });

  for (const section of SECTIONS) {
    it(`cada una de ${section} está en el lockfile con el mismo specifier`, () => {
      const wanted = pkgJson[section] ?? {};
      const problems: string[] = [];
      for (const [name, spec] of Object.entries(wanted)) {
        const got = lock[section][name];
        if (got === undefined) problems.push(`${name}: falta en pnpm-lock.yaml (package.json pide ${spec})`);
        else if (got !== spec) problems.push(`${name}: package.json pide ${spec} y pnpm-lock.yaml tiene ${got}`);
      }
      // Lo que sobra en el lockfile también hace fallar --frozen-lockfile.
      for (const name of Object.keys(lock[section])) {
        if (!(name in wanted)) problems.push(`${name}: está en pnpm-lock.yaml (${section}) pero no en package.json`);
      }
      expect(problems, "corre `pnpm install` y sube pnpm-lock.yaml en el mismo commit").toEqual([]);
    });
  }

  it("el lockfile no está vacío (el lector no se saltó todo)", () => {
    expect(Object.keys(lock.dependencies).length).toBe(Object.keys(pkgJson.dependencies ?? {}).length);
    expect(Object.keys(lock.dependencies).length).toBeGreaterThan(0);
    expect(lock.dependencies.jssip).toBe("3.13.8");
  });
});
