// «Pago solo online (lista automática)»: lo que tiene que quedar escrito y
// conectado (MOM §8, §40 y §41.11; DEPLOY; el pedido de las tiendas; el cron;
// el catálogo del panel; dónde está el freno).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { automationEventLabel, automationValueLabel, PAGO_ONLINE_MODE_EVENT, PAGO_ONLINE_REQUIREMENT_EVENT } from "@/lib/automations-catalog";
import { PAGO_ONLINE_KEY } from "@/lib/pago-online";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("los documentos", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const s4111 = flat(mom.slice(mom.indexOf("### 41.11 "), mom.indexOf("## 42. ")));

  it("el MOM tiene la regla del owner, el adelanto por defecto y el freno como fuente de la misma compuerta", () => {
    expect(s4111).toContain("**Cliente = los últimos 9 dígitos del celular**");
    expect(s4111).toContain("`devuelto`, o `anulado` con `dispatched_at`");
    expect(s4111).toContain("**«Adelanto (regla §8)»** (`adelanto`, por defecto)");
    expect(s4111).toContain("**«Pago completo»** (`pago_completo`)");
    expect(s4111).toContain("`prepayOrderCheck`");
    expect(s4111).toContain("Cliente con entrega fallida y ninguna recibida: solo pago online o adelanto");
    expect(s4111).toContain("**404** es «la tienda todavía no tiene el endpoint»");
    expect(s4111).toContain("0326_pago_solo_online.sql");
    // §8 y §40 apuntan aquí.
    expect(flat(mom.slice(mom.indexOf("## 8. Confirmación y riesgo del cliente"), mom.indexOf("### 8.1 ")))).toContain("«Pago solo online» (§41.11, owner 09-11-2026)");
    expect(flat(mom.slice(mom.indexOf("## 40. Panel de automatizaciones"), mom.indexOf("## 41. ")))).toContain("**Pago solo online (lista automática)** (§41.11");
  });

  it("el pedido de las tiendas está en el repo, con la pregunta 3 respondida por el owner", () => {
    const doc = read("docs/kapta/pago-solo-online.md");
    expect(doc).toContain("# Pedido para Kapta: lista automática de «pago solo online»");
    expect(doc).toContain("**Decisión del owner (09-11-2026): adelanto.**");
  });

  it("DEPLOY la pone arriba, con la migración y la prueba", () => {
    const deploy = read("DEPLOY.md");
    const top = deploy.indexOf("### ");
    expect(deploy.slice(top, top + 200)).toContain("0326");
    expect(deploy).toContain("psql \"$DATABASE_URL\" -f db/migrations/0326_pago_solo_online.sql");
    expect(deploy).toContain("«Enviar prueba»");
  });
});

describe("las piezas conectadas", () => {
  it("el cron corre cada minuto de las 05:00 de Lima", () => {
    const cfg = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(cfg.crons.find((c) => c.path === "/api/cron/pago-solo-online")?.schedule).toBe("* 10 * * *");
    expect(read("app/api/cron/pago-solo-online/route.ts")).toContain("internalAuthorized(req)");
  });

  it("el historial del panel nombra la posición y el cobro", () => {
    expect(PAGO_ONLINE_MODE_EVENT).toBe(PAGO_ONLINE_KEY);
    expect(PAGO_ONLINE_KEY).toBe("pago_solo_online");
    expect(automationEventLabel(PAGO_ONLINE_MODE_EVENT)).toBe("Pago solo online (lista automática)");
    expect(automationValueLabel(PAGO_ONLINE_REQUIREMENT_EVENT, "adelanto")).toBe("Adelanto (regla §8)");
    expect(automationValueLabel(PAGO_ONLINE_REQUIREMENT_EVENT, "pago_completo")).toBe("Pago completo");
  });

  it("el freno vive dentro de `prepayOrderCheck`, después de la lista de pago adelantado", () => {
    const src = read("lib/prepay-list-server.ts");
    const fn = src.slice(src.indexOf("export async function prepayOrderCheck("), src.indexOf("export async function prepayGuideBlock("));
    expect(fn.indexOf("prepayLookup(admin, orgId")).toBeGreaterThan(0);
    expect(fn.indexOf("pagoOnlineLookup(admin, orgId")).toBeGreaterThan(fn.indexOf("prepayLookup(admin, orgId"));
  });

  it("Chatby lo deja para la asesora sin escribirle a la clienta", () => {
    const src = read("lib/chatby-autoconfirm-server.ts");
    expect(src).toContain('return { kind: "hold", reason: "pago_online", detail: prepay.message, state: "para_persona" };');
    expect(src).toContain('if (prepay.state === "blocked" && prepay.source === "pago_online") return "pago solo online (lista automática)";');
  });

  it("los celulares de la lista no tienen acceso del navegador", () => {
    const sql = read("db/migrations/0326_pago_solo_online.sql");
    expect(sql).not.toMatch(/create policy pago_online_phones/);
    expect(sql).toMatch(/grant select on public\.pago_online_settings, public\.pago_online_runs, public\.pago_online_sends,\s+public\.pago_online_exceptions to authenticated;/);
    expect(sql).toContain("revoke all on function public.pago_online_lookup(uuid, text) from public, anon, authenticated;");
  });
});
