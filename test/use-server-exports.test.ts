import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Un archivo «use server» solo puede exportar funciones async: Next lo valida
// al cargar cualquier acción de la ruta y, si encuentra otra cosa, responde
// 500 a todas las acciones de esa ruta (no solo a la del archivo culpable).
// Así se rompió «Ver actividad» en Despacho del día: app/reparto/receive.ts
// exportaba la lista de motivos de «no lo recojo». Este test lo atrapa en CI
// en vez de en producción.

const ROOTS = ["app", "lib", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function isUseServerFile(source: string): boolean {
  // La directiva va antes de cualquier código; solo la preceden comentarios.
  const head = source.replace(/^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "");
  return /^\s*["']use server["']\s*;?/.test(head);
}

const ALLOWED = /^export\s+(async\s+function\b|default\s+async\s+function\b|type\b|interface\b)/;

describe("archivos «use server»", () => {
  const files = ROOTS.flatMap((r) => walk(r)).filter((f) => isUseServerFile(readFileSync(f, "utf8")));

  it("existen (si no, el test mira en el sitio equivocado)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("solo exportan funciones async", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/^export\b/.test(line)) return;
        if (ALLOWED.test(line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "mueve estas exportaciones a un módulo sin «use server»").toEqual([]);
  });
});
