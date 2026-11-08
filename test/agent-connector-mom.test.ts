// El conector de IA (MOM §42, 08-11-2026): que lo que el MOM y el runbook citan
// —el prefijo, el tope, los permisos, las herramientas, los códigos de la ruta,
// la migración— sea lo que hacen el código y la base. Las reglas, a fondo, en
// test/agent-connector.test.ts y scripts/sql/agent_tokens_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_RATE_PER_MINUTE, AGENT_SCOPES, AGENT_TOKEN_PREFIX } from "@/lib/agent-auth";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { MCP_PROTOCOL_VERSIONS } from "@/lib/mcp-server";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const DEPLOY = read("DEPLOY.md");
const MIGRATION = read("db/migrations/0314_agent_tokens.sql");
const ROUTE = read("app/api/mcp/route.ts");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

describe("§42 Conector para agentes de IA", () => {
  const s42 = section("## 42. Conector para agentes de IA (Grok Bot, 08-11-2026)");

  it("registra lo que decidió el owner y que esta parte solo lee", () => {
    expect(s42).toContain("«Quiero construir un agente de Grok Bot para que gestione cosas en específico del sistema»");
    expect(s42).toContain("crear guías de Aliclik, dejar notas en el pedido y enviar WhatsApp al cliente");
    expect(s42).toContain("No cambia estados ni anula guías.");
    expect(s42).toContain("**Esta (parte 1) es de solo lectura.**");
    // Ninguna herramienta escribe todavía.
    expect(AGENT_TOOLS.every((t) => !AGENT_SCOPES[t.scope].write)).toBe(true);
  });

  it("las herramientas y sus permisos son los del código", () => {
    const s423 = section("### 42.3 Las herramientas (solo lectura)");
    for (const tool of AGENT_TOOLS) {
      expect(s423).toContain(`| \`${tool.name}\` | \`${tool.scope}\` |`);
    }
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["buscar_pedidos", "obtener_pedido", "leer_conversacion", "consultar_politicas"]);
    expect(s423).toContain(`(${ADELANTO_MINIMO_LABEL}, \`lib/adelanto-minimo.ts\`)`);
    expect(s423).toContain("**toda consulta va filtrada por las tiendas del token**");
  });

  it("los permisos de la base son los del código, y los de escritura esperan la parte 3", () => {
    const scopes = Object.keys(AGENT_SCOPES);
    const inMigration = MIGRATION.match(/scopes <@ array\[([^\]]+)\]/)![1]!.match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
    expect(inMigration).toEqual(scopes);
    const s426 = section("### 42.6 Pendiente");
    for (const [key, s] of Object.entries(AGENT_SCOPES)) {
      if (s.write) expect(s426).toContain(`\`${key}\``);
    }
  });

  it("el token, el tope y las respuestas de la puerta son los del código", () => {
    const s422 = section("### 42.2 El token");
    expect(AGENT_TOKEN_PREFIX).toBe("kagt_");
    expect(s422).toContain("El token es `kagt_` + 32 bytes al azar en base64url; **se muestra una sola vez**");
    expect(AGENT_RATE_PER_MINUTE).toBe(60);
    expect(s422).toContain("**60 llamadas por minuto** por token");
    expect(s422).toContain("**401 «No autorizado.»**");
    expect(s422).toContain("**403 `sin_tiendas`**");
    expect(ROUTE).toContain(`'Bearer realm="kapta"'`);
    expect(s422).toContain('`WWW-Authenticate: Bearer realm="kapta"`');
  });

  it("el protocolo es el de la ruta", () => {
    const s421 = section("### 42.1 El servidor");
    for (const v of MCP_PROTOCOL_VERSIONS) expect(s421).toContain(`\`${v}\``);
    expect(ROUTE).toContain("MCP_MAX_BODY_BYTES = 65_536");
    expect(s421).toContain("un cuerpo de más de 64 KB, **413**");
    expect(s421).toContain("Una notificación se contesta **202 sin cuerpo**");
    expect(ROUTE).toMatch(/export const GET = notAllowed;\nexport const DELETE = notAllowed;/);
  });

  it("el registro no guarda lo que se preguntó", () => {
    const s424 = section("### 42.4 El registro");
    expect(s424).toContain("**Sin lo que se preguntó ni lo que se contestó** (ni teléfonos ni nombres)");
    expect(MIGRATION).toMatch(/tool\s+text not null check \(tool ~ '\^\[a-z_\]\{2,40\}\$'\)/);
    expect(MIGRATION).not.toMatch(/agent_tool_calls[\s\S]*\b(arguments|request|response|phone)\b\s+(text|jsonb)/);
  });

  it("§40 lleva al conector y la migración está en la lista", () => {
    expect(section("## 40. Panel de automatizaciones (04-11-2026)")).toContain("**Conector de IA** (§42, 08-11-2026)");
    expect(s42).toContain("Migración `0314_agent_tokens.sql`.");
    expect(read("db/apply.sql")).toContain("0314_agent_tokens.sql");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/agent_tokens_smoke.sql");
  });
});

describe("DEPLOY.md", () => {
  const title = "### 08-11-2026 · Conector de IA para Grok Bot: `/api/mcp` y sus tokens (0314, MOM §42)";
  it("la entrada dice que la 0314 va antes del código, cómo comprobarla y la marcha atrás", () => {
    const start = DEPLOY.indexOf(title);
    expect(start).toBeGreaterThan(-1);
    const next = DEPLOY.indexOf("\n### ", start + 10);
    const body = flat(DEPLOY.slice(start, next === -1 ? undefined : next));
    expect(body).toContain("**Aplicada en producción el 08-11-2026.**");
    expect(body).toContain("**Migración `0314_agent_tokens.sql`**, a mano, ANTES del código");
    expect(body).toContain("select to_regclass('public.agent_tokens'), to_regclass('public.agent_tool_calls');");
    expect(body).toContain("**Sin la migración**, `/api/mcp` contesta 503");
    expect(body).toContain("**Marcha atrás.**");
  });
});
