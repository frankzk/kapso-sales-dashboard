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

  it("mantiene los trece crons con expresiones válidas de 5 campos", () => {
    const crons = cfg.crons as { path: string; schedule: string }[];
    expect(crons).toHaveLength(13);
    for (const c of crons) {
      expect(c.path.startsWith("/api/cron/")).toBe(true);
      expect(c.schedule.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  it("el barrido de Aliclik y su cierre no arrancan en el mismo minuto", () => {
    // Son dos crones justamente porque no caben en una invocación: el barrido
    // agotaba `maxDuration` y el cierre, que iba detrás, no llegaba a correr
    // nunca. Lanzarlos a la vez les haría pelearse por la misma ventana de
    // ejecución y por el mismo cupo de la API de Aliclik. El cierre va al medio,
    // sobre el barrido ya terminado y con su constancia recién escrita.
    const crons = cfg.crons as { path: string; schedule: string }[];
    const at = (path: string) => crons.find((c) => c.path === path)?.schedule;
    expect(at("/api/cron/aliclik-reconcile")).toBe("*/20 * * * *");
    expect(at("/api/cron/aliclik-close")).toBe("10,30,50 * * * *");
  });

  it("las tarifas de Aliclik NO se cotizan en la franja mala de su API", () => {
    // Los 5xx de Aliclik llegan siempre a la misma hora: el 29/07 fallaron 136
    // de 203 peticiones entre las 09:25 y las 09:45 UTC, y el 17/08 saltó una
    // alerta de Vercel con 78 fallos a partir de las 09:30 UTC clavadas — la
    // hora a la que estaba agendado este cron. Son las 04:25-04:45 de Lima:
    // parece su ventana de mantenimiento.
    //
    // Devolverlo a esa hora no rompe nada de forma visible: el cron sigue
    // "funcionando", solo que las tarifas no se refrescan y llega un correo de
    // alerta que se parece demasiado a una caída de verdad. Por eso se fija acá.
    const crons = cfg.crons as { path: string; schedule: string }[];
    const schedule = crons.find((c) => c.path === "/api/cron/aliclik-tariffs")?.schedule;
    expect(schedule).toBeDefined();
    const [minute, hour] = schedule!.trim().split(/\s+/);
    // Una hora fija, no un comodín: `*` o `*/n` lo harían pasar por la franja.
    expect(hour).toMatch(/^\d+$/);
    expect(minute).toMatch(/^\d+$/);
    const minutosUtc = Number(hour) * 60 + Number(minute);
    // Ventana vedada con margen a cada lado: la racha dura minutos, y la pasada
    // también, así que arrancar cerca del borde igual la pisa.
    const desde = 8 * 60 + 30; // 08:30 UTC
    const hasta = 10 * 60 + 45; // 10:45 UTC
    expect(minutosUtc >= desde && minutosUtc <= hasta).toBe(false);
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
