import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guarda de `vercel.json`.
//
// POR QUÉ EXISTE ESTE TEST. Una clave desconocida en vercel.json no produce un
// aviso: Vercel rechaza el fichero contra su esquema y el despliegue falla ANTES
// de compilar, sin logs de build. El síntoma es "producción se quedó en el
// commit anterior", que es de los más difíciles de atribuir — y bloquea también
// los despliegues siguientes de cualquier otra rama.
//
// Pasó de verdad: se añadió una clave "//regions" a modo de comentario (JSON no
// admite comentarios, y este esquema tampoco claves extra) y tumbó dos
// despliegues a producción seguidos.

const cfg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../vercel.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

/** Claves que acepta el esquema de vercel.json. */
const ALLOWED = new Set([
  "$schema",
  "build",
  "buildCommand",
  "builds",
  "cleanUrls",
  "crons",
  "devCommand",
  "env",
  "framework",
  "functionFailoverRegions",
  "functions",
  "git",
  "github",
  "headers",
  "ignoreCommand",
  "images",
  "installCommand",
  "name",
  "outputDirectory",
  "public",
  "redirects",
  "regions",
  "rewrites",
  "routes",
  "trailingSlash",
  "version",
]);

describe("vercel.json", () => {
  it("no tiene claves desconocidas — una sola tumba el despliegue sin logs", () => {
    const unknown = Object.keys(cfg).filter((k) => !ALLOWED.has(k));
    expect(unknown).toEqual([]);
  });

  it("no intenta usar claves de comentario, que este esquema no admite", () => {
    const commentish = Object.keys(cfg).filter((k) => k.startsWith("//") || k.startsWith("#"));
    expect(commentish).toEqual([]);
  });

  it("declara la región de las funciones", () => {
    // gru1 = São Paulo, donde vive el proyecto de Supabase (sa-east-1). Sin esto
    // Vercel usa iad1 (Virginia) y cada consulta cruza el hemisferio.
    expect(cfg.regions).toEqual(["gru1"]);
  });

  it("mantiene los once crons con expresiones válidas de 5 campos", () => {
    const crons = cfg.crons as { path: string; schedule: string }[];
    expect(crons).toHaveLength(11);
    for (const c of crons) {
      expect(c.path.startsWith("/api/cron/")).toBe(true);
      expect(c.schedule.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  it("cada cron apunta a una ruta que existe", () => {
    // Un cron con la ruta mal escrita no falla el despliegue: se ejecuta y
    // devuelve 404 en silencio, que es la forma más cara de no enterarse.
    const crons = cfg.crons as { path: string; schedule: string }[];
    for (const c of crons) {
      const route = new URL(`../app${c.path}/route.ts`, import.meta.url);
      expect(() => readFileSync(fileURLToPath(route), "utf8"), c.path).not.toThrow();
    }
  });
});
