// Ajustes → «Bot de Kapso → pedidos por Kapta» (MOM §38.13): el secreto del bot
// se genera con «Administrar tiendas», se guarda solo su sha256, vuelve UNA vez
// en la respuesta y cambiarlo invalida el anterior; «Desactivar» lo borra. Sin
// la 0277 lo dice. Y la página nunca manda el hash al navegador. Sin red ni
// base real.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
  allowed: true,
  revalidated: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.db.client(),
  createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: vi.fn(async (_org: string, perm: string) => h.allowed && perm === "stores.manage"),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));

import { generateBotOrdersSecret, revokeBotOrdersSecret } from "@/app/dashboard/[storeId]/settings/bot-orders-actions";
import { BOT_SECRET_PREFIX, botSecretMatches, hashBotSecret } from "@/lib/bot-orders";
import { FakeDb } from "./woocommerce-fake-db";

const STORE = "11111111-1111-4111-8111-111111111111";

function form(storeId = STORE): FormData {
  const fd = new FormData();
  fd.set("store_id", storeId);
  return fd;
}

beforeEach(() => {
  h.allowed = true;
  h.revalidated = [];
  h.db = new FakeDb({ stores: [{ id: STORE, org_id: "org-1" }] });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("generar y cambiar el secreto del bot", () => {
  it("lo genera, guarda solo su sha256 y lo devuelve una vez", async () => {
    const res = await generateBotOrdersSecret({}, form());
    expect(res.error).toBeUndefined();
    expect(res.botSecret).toMatch(new RegExp(`^${BOT_SECRET_PREFIX}[A-Za-z0-9_-]{43}$`));
    const rows = h.db.rows("bot_order_secrets");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: STORE, secret_hash: hashBotSecret(res.botSecret!) });
    expect(rows[0]!.created_at).toBe(rows[0]!.rotated_at);
    // Nada en la base lleva el secreto en claro.
    expect(JSON.stringify(h.db.tables)).not.toContain(res.botSecret!);
    expect(res.notice).toContain("no se vuelve a mostrar");
    expect(h.revalidated).toEqual([`/dashboard/${STORE}/settings`]);
    // El registro dice quién y cuándo, nunca el secreto.
    const logged = vi.mocked(console.info).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"step":"secret_created"');
    expect(logged).not.toContain(res.botSecret!);
  });

  it("cambiarlo invalida el anterior en el acto y conserva cuándo se creó", async () => {
    const first = await generateBotOrdersSecret({}, form());
    const created = h.db.rows("bot_order_secrets")[0]!.created_at;
    await new Promise((r) => setTimeout(r, 5));
    const second = await generateBotOrdersSecret({}, form());
    expect(second.botSecret).not.toBe(first.botSecret);
    const row = h.db.rows("bot_order_secrets")[0]!;
    expect(h.db.rows("bot_order_secrets")).toHaveLength(1);
    expect(row.created_at).toBe(created);
    expect(row.rotated_at > created).toBe(true);
    expect(botSecretMatches(first.botSecret, row.secret_hash)).toBe(false);
    expect(botSecretMatches(second.botSecret, row.secret_hash)).toBe(true);
    expect(second.notice).toContain("El anterior ya no sirve");
  });

  it("sin «Administrar tiendas», o con una tienda que no existe: nada", async () => {
    h.allowed = false;
    expect(await generateBotOrdersSecret({}, form())).toEqual({ error: "Sin permiso." });
    h.allowed = true;
    expect(await generateBotOrdersSecret({}, form("22222222-2222-4222-8222-222222222222"))).toEqual({ error: "Sin permiso." });
    expect(h.db.rows("bot_order_secrets")).toHaveLength(0);
  });

  it("sin la 0277: lo dice y no guarda nada", async () => {
    h.db.failOn = (table) =>
      table === "bot_order_secrets" ? { code: "PGRST205", message: "Could not find the table 'public.bot_order_secrets' in the schema cache" } : null;
    const res = await generateBotOrdersSecret({}, form());
    expect(res).toEqual({ error: "Falta aplicar la migración 0277 (pedidos del bot) en la base: no se creó nada." });
  });

  it("«Desactivar» lo borra: desde ahí el bot recibe 401", async () => {
    const res = await generateBotOrdersSecret({}, form());
    expect(h.db.rows("bot_order_secrets")).toHaveLength(1);
    const off = await revokeBotOrdersSecret({}, form());
    expect(off.notice).toContain("Desactivado");
    expect(h.db.rows("bot_order_secrets")).toHaveLength(0);
    expect(res.botSecret).toBeTruthy();
  });
});

describe("la página y la sección", () => {
  it("la página lee del secreto solo fechas y último uso, nunca el hash; la sección no importa node:crypto", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/[storeId]/settings/page.tsx"), "utf8");
    const read = /\.from\("bot_order_secrets"\)\s*\.select\("([^"]+)"\)/.exec(page);
    expect(read?.[1]).toBe("created_at, rotated_at, last_used_at, last_outcome, last_error, last_error_at");
    expect(page).toContain("endpointUrl: botOrdersEndpointUrl(siteUrl || env.siteUrl(), storeId)");
    const section = readFileSync(resolve(process.cwd(), "components/bot-orders-settings-section.tsx"), "utf8");
    expect(section).not.toMatch(/^import[^;]*(?:from "@\/lib\/bot-orders"|"node:crypto")/m);
    expect(section).toContain('from "@/app/dashboard/[storeId]/settings/bot-orders-actions"');
    const settings = readFileSync(resolve(process.cwd(), "components/store-settings.tsx"), "utf8");
    expect(settings).toContain('{ id: "bot-pedidos", label: "Bot de Kapso → pedidos" }');
    expect(settings).toContain("<BotOrdersSettingsSection storeId={s.id} data={data.botOrders} />");
  });
});
