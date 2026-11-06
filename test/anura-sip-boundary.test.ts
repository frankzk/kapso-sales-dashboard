// «Llamar con Anura», fase 2: dónde vive JsSIP.
//   - `jssip` en la versión EXACTA que probó Rentabilify con Anura Perú (3.13.8);
//   - solo lib/anura/jssip-client.ts lo carga, y solo con import dinámico: así
//     nunca entra al bundle del servidor ni a la primera carga de la ficha;
//   - a ese archivo solo lo importan componentes de cliente;
//   - la lógica del teléfono (lib/anura/sip-phone.ts, lib/anura/sip.ts) es pura:
//     sin jssip, sin server-only, sin módulos de Node;
//   - lo que descifra la clave SIP es server-only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCES = ["app", "components", "lib"].flatMap((d) => walk(d));

const staticImports = (src: string) =>
  [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?\s+from\s+["']([^"']+)["']/g), ...src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map((m) => m[1]!);
const dynamicImports = (src: string) => [...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);

describe("JsSIP solo en el navegador", () => {
  it("la versión exacta 3.13.8", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.jssip).toBe("3.13.8");
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/jssip"]?.version).toBe("3.13.8");
  });

  it("solo lib/anura/jssip-client.ts lo carga, y con import dinámico", () => {
    const users = SOURCES.filter((f) => {
      const src = read(f);
      return staticImports(src).includes("jssip") || dynamicImports(src).includes("jssip");
    });
    expect(users).toEqual([path.join("lib", "anura", "jssip-client.ts")]);
    const client = read("lib/anura/jssip-client.ts");
    expect(staticImports(client)).not.toContain("jssip");
    expect(dynamicImports(client)).toContain("jssip");
  });

  it("a jssip-client solo lo importan componentes de cliente", () => {
    for (const f of SOURCES) {
      const src = read(f);
      if (!staticImports(src).includes("@/lib/anura/jssip-client") && !dynamicImports(src).includes("@/lib/anura/jssip-client")) continue;
      expect(src.trimStart().startsWith('"use client";'), f).toBe(true);
    }
  });

  it("la lógica del teléfono es pura: sin jssip, sin server-only, sin Node", () => {
    for (const f of ["lib/anura/sip-phone.ts", "lib/anura/sip.ts", "lib/anura/jssip-client.ts"]) {
      const imports = staticImports(read(f));
      expect(imports.filter((s) => s === "jssip" || s === "server-only" || s.startsWith("node:")), f).toEqual([]);
      for (const bad of ["@/lib/anura/server", "@/lib/anura/sip-store", "@/lib/anura/calls", "@/lib/crypto", "@/lib/db", "@/lib/env"]) {
        expect(imports, `${f} → ${bad}`).not.toContain(bad);
      }
    }
  });

  it("lo que descifra la clave SIP es server-only", () => {
    for (const f of ["lib/anura/sip-store.ts", "lib/anura/server.ts"]) expect(staticImports(read(f))).toContain("server-only");
    expect(staticImports(read("lib/anura/sip-store.ts"))).toContain("@/lib/crypto");
  });

  it("la clave SIP no se escribe en ningún log ni en el almacenamiento del navegador", () => {
    for (const f of ["lib/anura/sip-store.ts", "lib/anura/server.ts", "lib/anura/sip-phone.ts", "lib/anura/jssip-client.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(src, f).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
