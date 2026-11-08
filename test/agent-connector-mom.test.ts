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
import { OAUTH_CODE_TTL_MS, OAUTH_REGISTRATIONS_PER_HOUR, OAUTH_SCOPES, authorizationServerMetadata } from "@/lib/agent-oauth";
import {
  POLICIES_FOR_AGENT_MAX,
  POLICY_BODY_MAX,
  POLICY_IMPORT_MAX,
  POLICY_SOURCE_MAX,
  POLICY_STATUS_LABEL,
  POLICY_TITLE_MAX,
  parsePoliciesMarkdown,
  policyStatus,
} from "@/lib/store-policies";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const DEPLOY = read("DEPLOY.md");
const MIGRATION = read("db/migrations/0314_agent_tokens.sql");
const ROUTE = read("app/api/mcp/route.ts");
const POLICIES_MIGRATION = read("db/migrations/0315_store_policies.sql");

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
    expect(s42).toContain("**Las partes 1 y 2 son de solo lectura para el agente.**");
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
    const s427 = section("### 42.7 Pendiente");
    for (const [key, s] of Object.entries(AGENT_SCOPES)) {
      if (s.write) expect(s427).toContain(`\`${key}\``);
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
    expect(ROUTE).toContain('`Bearer realm="kapta", resource_metadata="${protectedResourceMetadataUrl(req.nextUrl.origin)}"`');
    expect(s422).toContain('`WWW-Authenticate: Bearer realm="kapta", resource_metadata="…"`');
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
    expect(s42).toContain("Migraciones `0314_agent_tokens.sql`, `0315_store_policies.sql` y `0319_agent_oauth.sql`.");
    expect(read("db/apply.sql")).toContain("0319_agent_oauth.sql");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/agent_oauth_smoke.sql");
    expect(read("db/apply.sql")).toContain("0314_agent_tokens.sql");
    expect(read("db/apply.sql")).toContain("0315_store_policies.sql");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/agent_tokens_smoke.sql");
    expect(read("scripts/verify-db.sh")).toContain("scripts/sql/store_policies_smoke.sql");
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

describe("§42.6 Políticas escritas por tienda", () => {
  const s426 = section("### 42.6 Políticas escritas por tienda (parte 2, 08-11-2026; 0315)");

  it("los topes del formulario son los del código y los de la base", () => {
    expect([POLICY_TITLE_MAX, POLICY_BODY_MAX, POLICY_SOURCE_MAX]).toEqual([80, 4000, 200]);
    expect(s426).toContain("**título** (de 2 a 80 caracteres), **texto** (hasta 4000, con sus párrafos)");
    expect(s426).toContain("**fuente** (opcional, hasta 200: de dónde sale)");
    expect(POLICIES_MIGRATION).toContain("check (length(btrim(title)) between 2 and 80)");
    expect(POLICIES_MIGRATION).toContain("check (length(btrim(body)) between 2 and 4000)");
    expect(POLICIES_MIGRATION).toContain("length(btrim(source)) between 1 and 200");
  });

  it("los estados son los del código, con el último día incluido", () => {
    expect(Object.values(POLICY_STATUS_LABEL)).toEqual(["Vigente", "Programada", "Vencida", "Retirada"]);
    for (const label of Object.values(POLICY_STATUS_LABEL)) expect(s426).toContain(`**${label}**`);
    expect(policyStatus({ valid_from: "2026-11-01", valid_until: "2026-11-08", retired_at: null }, "2026-11-08")).toBe("vigente");
    expect(s426).toContain("**hasta** (opcional; ese día todavía vale)");
    expect(s426).toContain("No son estados del pedido: son de la política.");
  });

  it("versión, historial y retirada son de la base", () => {
    expect(s426).toContain("La versión la pone la base (1 al nacer, +1 en cada cambio), y guardar sin cambios no crea una.");
    expect(POLICIES_MIGRATION).toContain("new.version := old.version + 1;");
    expect(s426).toContain("**Retirar** es final");
    expect(POLICIES_MIGRATION).toContain("una política retirada no se edita");
    expect(s426).toContain("La escribe la base sola (disparador) y nadie la edita ni la borra, ni el servidor");
    expect(POLICIES_MIGRATION).toContain("grant select on store_policy_versions to service_role;");
    expect(POLICIES_MIGRATION).toContain("grant select, insert, update on store_policies to service_role;");
    expect(POLICIES_MIGRATION).not.toMatch(/grant[^;]*delete[^;]*store_polic/i);
  });

  it("importar desde Markdown", () => {
    expect(POLICY_IMPORT_MAX).toBe(50);
    expect(s426).toContain("**Importar desde Markdown** (08-11-2026, pedido del owner: «¿no puedo subir el md?»)");
    expect(s426).toContain("**No se importa** lo que todavía dice `[CONFIRMAR`");
    expect(s426).toContain("Hasta 50 por importación, todas desde el mismo día y en un solo `insert`.");
    const md = "## Kenku Peru\n### Cambios\nSiete días.\n## Cómo usar\n### Nota\nNo entra.\n## Aurela\n### Garantía\n[CONFIRMAR: plazo]";
    const out = parsePoliciesMarkdown(md, [{ id: "k", name: "Kenku Peru" }, { id: "a", name: "Aurela" }], null, "2026-11-08");
    expect(out.policies.map((p) => p.title)).toEqual(["Cambios"]);
    expect(out.skipped.map((p) => p.title)).toEqual(["Garantía"]);
  });

  it("lo que lee el agente", () => {
    expect(POLICIES_FOR_AGENT_MAX).toBe(20);
    expect(s426).toContain("las **vigentes ese día de Lima** de la tienda que pidió, por título, hasta 20");
    expect(s426).toContain("`escritas` es `null` con su nota, que no es lo mismo que «ninguna», y las calculadas siguen.");
  });
});

describe("DEPLOY.md 0315", () => {
  const title = "### 08-11-2026 · Políticas escritas por tienda para el agente de IA (0315, MOM §42.6)";
  it("la entrada dice que la 0315 va antes del código, cómo comprobarla y la marcha atrás", () => {
    const start = DEPLOY.indexOf(title);
    expect(start).toBeGreaterThan(-1);
    const next = DEPLOY.indexOf("\n### ", start + 10);
    const body = flat(DEPLOY.slice(start, next === -1 ? undefined : next));
    expect(body).toContain("**Aplicada en producción el 08-11-2026.**");
    expect(body).toContain("**Migración `0315_store_policies.sql`**, a mano, ANTES del código");
    expect(body).toContain("select to_regclass('public.store_policies'), to_regclass('public.store_policy_versions');");
    expect(body).toContain("**Marcha atrás.**");
  });
});

describe("§42.8 Conectar con OAuth", () => {
  const s428 = section("### 42.8 Conectar con OAuth, sin copiar tokens (08-11-2026; 0319)");
  const OAUTH_MIGRATION = read("db/migrations/0319_agent_oauth.sql");

  it("los números y las reglas son los del código", () => {
    expect(OAUTH_REGISTRATIONS_PER_HOUR).toBe(30);
    expect(s428).toContain("Tope: **30 registros nuevos por hora** entre todos.");
    expect(OAUTH_CODE_TTL_MS).toBe(10 * 60_000);
    expect(s428).toContain("crea un **código de un solo uso, de 10 minutos**");
    expect(authorizationServerMetadata("https://k.example")).toMatchObject({ code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(s428).toContain("solo `code`, `authorization_code`, clientes públicos (`none`) y PKCE `S256`.");
    expect(OAUTH_SCOPES.every((s) => !AGENT_SCOPES[s].write)).toBe(true);
    expect(s428).toContain("Por OAuth solo se dan las herramientas de lectura");
    expect(s428).toContain("**Registrarse no da acceso a nada.**");
    expect(s428).toContain("**no redirigen nunca**");
    expect(s428).toContain("**Si un código ya usado se vuelve a presentar, se revoca el token que se dio con él.**");
  });

  it("la migración guarda el hash del código, su vencimiento y de qué cliente vino cada token", () => {
    expect(OAUTH_MIGRATION).toContain("code_hash       text primary key check (code_hash ~ '^[0-9a-f]{64}$')");
    expect(OAUTH_MIGRATION).toContain("expires_at <= created_at + interval '15 minutes'");
    expect(OAUTH_MIGRATION).toContain("alter table agent_tokens add column if not exists oauth_client_id text;");
    expect(OAUTH_MIGRATION).not.toMatch(/client_secret/);
  });

  it("§42.2 y §42.5 lo citan", () => {
    expect(section("### 42.5 Cómo se conecta Grok")).toContain("**Grok Bot, con OAuth (§42.8):**");
  });
});

describe("DEPLOY.md 0319", () => {
  const title = "### 08-11-2026 · Conector de IA: conectar Grok con OAuth, sin copiar tokens (0319, MOM §42.8)";
  it("la entrada dice que la 0319 va antes del código, cómo comprobarla y la marcha atrás", () => {
    const start = DEPLOY.indexOf(title);
    expect(start).toBeGreaterThan(-1);
    const next = DEPLOY.indexOf("\n### ", start + 10);
    const body = flat(DEPLOY.slice(start, next === -1 ? undefined : next));
    expect(body).toContain("**Pendiente de aplicar en producción.**");
    expect(body).toContain("**Migración `0319_agent_oauth.sql`**, a mano, ANTES del código");
    expect(body).toContain("select to_regclass('public.agent_oauth_clients'), to_regclass('public.agent_oauth_codes');");
    expect(body).toContain("**Marcha atrás.**");
  });
});
