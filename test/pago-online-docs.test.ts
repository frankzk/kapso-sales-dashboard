// «Pago solo online (lista automática)»: lo que tiene que quedar escrito y
// conectado (MOM §8, §40 y §41.11; DEPLOY; el pedido de las tiendas; el cron;
// el catálogo del panel; dónde está el freno).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { automationEventLabel, automationValueLabel, PAGO_ONLINE_MODE_EVENT, PAGO_ONLINE_REQUIREMENT_EVENT } from "@/lib/automations-catalog";
import { PAGO_ONLINE_ANULADOR_MIN_ORDERS, PAGO_ONLINE_ANULADOR_RATIO, PAGO_ONLINE_KEY } from "@/lib/pago-online";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("los documentos", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const s4111 = flat(mom.slice(mom.indexOf("### 41.11 "), mom.indexOf("## 42. ")));

  it("el MOM tiene la regla del owner, el adelanto por defecto y el freno como fuente de la misma compuerta", () => {
    expect(s4111).toContain("**Cliente = los últimos 9 dígitos del celular**");
    expect(s4111).toContain("**(A) devolvió:** tiene al menos un `devuelto`");
    expect(s4111).toContain("**(B) el «anulador»:** tiene **5 o más** pedidos");
    expect(s4111).toContain("**el 75 % o más** están `anulado`");
    expect(s4111).toContain("**Los pedidos de la migración de plataforma no cuentan como pedido ni como");
    expect(s4111).toContain("**«Recibió» es CUALQUIER pedido `entregado`**");
    expect(s4111).toContain("**Un anulado después de salir, solo, ya no basta**");
    expect(s4111).toContain("**El bot de Kapso** (`POST /api/internal/orders`, owner 09-11-2026)");
    expect(s4111).toContain("**«Generar pedido» de Leads** (owner 09-11-2026)");
    expect(s4111).toContain("**«Vaciar la lista de la tienda»**");
    expect(s4111).toContain("**«Adelanto de S/ 20»** (`adelanto`, por defecto; antes «Adelanto (regla §8)»)");
    expect(s4111).toContain("**«Pago total»** (`pago_completo`; antes «Pago completo»)");
    expect(s4111).toContain("`prepayOrderCheck`");
    expect(s4111).toContain("«Lista negra (devolvió N pedidos y nunca recibió): falta el adelanto de S/ 20 validado.»");
    // Cómo se dice (lib/lista-negra-copy.ts) y la fórmula larga de antes, fuera.
    expect(s4111).toContain("**Cómo se dice (owner, 09-11-2026; `lib/lista-negra-copy.ts`, la única fuente).**");
    expect(s4111).toContain("**Lo que va a las tiendas es la Lista negra entera (owner, 09-11-2026).**");
    expect(s4111).not.toContain("solo pago online o adelanto");
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
    expect(doc).toContain("la regla final del owner cambió, y la lista de Kapta manda.");
    expect(doc).toContain("la consulta de la sección 3.1 ya no reproduce la lista");
  });

  it("DEPLOY la pone arriba, con la migración y la prueba", () => {
    const deploy = read("DEPLOY.md");
    // La entrada se busca por su título: otras entradas (0328…) van encima.
    const top = deploy.indexOf("### 09-11-2026 · «Pago solo online (lista automática)»");
    expect(top).toBeGreaterThan(0);
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
    expect(automationEventLabel("pago_solo_online_vaciar")).toBe("Lista negra · lista de la tienda vaciada");
    expect(automationEventLabel(PAGO_ONLINE_MODE_EVENT)).toBe("Lista negra · posición");
    expect(automationValueLabel(PAGO_ONLINE_REQUIREMENT_EVENT, "adelanto")).toBe("Adelanto de S/ 20");
    expect(automationValueLabel(PAGO_ONLINE_REQUIREMENT_EVENT, "pago_completo")).toBe("Pago total");
  });

  it("el freno vive dentro de `prepayOrderCheck`, después de la lista de pago adelantado", () => {
    const src = read("lib/prepay-list-server.ts");
    const fn = src.slice(src.indexOf("export async function prepayOrderCheck("), src.indexOf("export async function prepayGuideBlock("));
    expect(fn.indexOf("prepayLookup(admin, orgId")).toBeGreaterThan(0);
    expect(fn.indexOf("pagoOnlineLookup(admin, orgId")).toBeGreaterThan(fn.indexOf("prepayLookup(admin, orgId"));
  });

  it("Chatby lo deja para la asesora sin escribirle a la clienta", () => {
    const src = read("lib/chatby-autoconfirm-server.ts");
    // Las dos listas por igual, con el texto de lib/lista-negra-copy.ts.
    expect(src).toContain('return { kind: "hold", reason: "pago_online", detail: lnChatbyHold(prepay.motivo, prepay.requirement), state: "para_persona" };');
    expect(src).toContain('if (prepay.state === "blocked") return LN_IN_PROSE;');
  });

  it("los umbrales del anulador y los hechos de la migración son los mismos en la 0326", () => {
    const sql = read("db/migrations/0326_pago_solo_online.sql");
    expect(sql).toContain("or (h.orders >= 5 and h.anulados::numeric >= 0.75 * h.orders))");
    expect(sql).toContain("`PAGO_ONLINE_ANULADOR_RATIO` (lib/pago-online.ts)");
    expect(sql).toContain("where ev.kind in ('cancelled_woocommerce', 'legacy_shopify_sale_cancelled', 'woo_sale_ended_pending_return')");
    expect(PAGO_ONLINE_ANULADOR_MIN_ORDERS).toBe(5);
    expect(PAGO_ONLINE_ANULADOR_RATIO).toBe(0.75);
    expect(sql).toContain("reason  text not null default 'devuelto' check (reason in ('devuelto', 'anulador')),");
  });

  it("el bot y «Generar pedido» miran la lista automática", () => {
    expect(read("lib/bot-orders.ts")).toContain('pagoOnlineOrderMessage("bot", auto.requirement, auto.who)');
    const leads = read("app/dashboard/leads/actions.ts");
    expect(leads).toContain('return mark?.requirement === "pago_completo" ? lnGenerateRefused(mark.motivo) : null;');
    expect(leads).toContain("const pagoOnlineNote = await generatedOrderPagoOnlineNote(admin, ctx.storeId, [phone, l.phone]);");
    // El Master marca las dos listas con UNA lectura y una sola chapa.
    expect(read("app/dashboard/pedidos/page.tsx")).toContain("rows={withListaNegra(");
    expect(read("components/orders-master.tsx")).toContain('{r.lista_negra && <ListaNegraBadge mark={r.lista_negra} className="xl:mt-0.5" />}');
  });

  it("los celulares de la lista no tienen acceso del navegador", () => {
    const sql = read("db/migrations/0326_pago_solo_online.sql");
    expect(sql).not.toMatch(/create policy pago_online_phones/);
    expect(sql).toMatch(/grant select on public\.pago_online_settings, public\.pago_online_runs, public\.pago_online_sends,\s+public\.pago_online_exceptions to authenticated;/);
    expect(sql).toContain("revoke all on function public.pago_online_lookup(uuid, text) from public, anon, authenticated;");
  });
});
