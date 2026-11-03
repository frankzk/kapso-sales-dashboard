import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SALES_CHANNEL_OPTIONS, SALES_CHANNEL_RULES, salesChannel } from "@/lib/sales-channel";
import { emptyFilters, matchesFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";
import type { OrderMasterRow } from "@/lib/types";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("canal de venta (MOM §3, 15-10-2026)", () => {
  it("lee las etiquetas reales de Shopify, sin importar mayúsculas", () => {
    expect(salesChannel(["easysell_cod_form", "CONFIRMADO", "draft_order_for_checkout_button"])).toBe("web_formulario");
    expect(salesChannel(["easysell_cod_form", "easysell-abandoned-checkout"])).toBe("web_carrito");
    expect(salesChannel(["venta_manual", "Rosario"])).toBe("asesora");
    expect(salesChannel(["venta_manual", "kapso"])).toBe("asesora");
    expect(salesChannel(["aurela", "contraentrega", "kapso", "whatsapp"])).toBe("chatbot");
    expect(salesChannel(["BOT", "CARRITO RECUPERADO"])).toBe("bot_carritos");
    expect(salesChannel(["BOT (whatsapp_cloud)"])).toBe("bot_carritos");
    expect(salesChannel(["catalogo-wsp", "Perú"])).toBe("catalogo");
    expect(salesChannel(["DAPHNE-CONFIRMADO"])).toBe("otro");
    expect(salesChannel(null)).toBe("otro");
  });
  it("la conversación de Kapso basta para el chatbot; la asesora gana igual", () => {
    expect(salesChannel(["easysell_cod_form"], "conv_1")).toBe("chatbot");
    expect(salesChannel(["venta_manual"], "conv_1")).toBe("asesora");
    expect(salesChannel([], "")).toBe("otro");
  });
  it("la migración 0264 tiene la misma regla, en el mismo orden", () => {
    const sql = read("db/migrations/0264_order_master_sales_channel.sql");
    let last = -1;
    for (const rule of SALES_CHANNEL_RULES) {
      const clause = `lt && array[${rule.tags.map((tag) => `'${tag}'`).join(", ")}] then '${rule.channel}'`;
      const at = sql.indexOf(clause);
      expect(at, rule.channel).toBeGreaterThan(last);
      last = at;
    }
    expect(sql).toContain("nullif(p_kapso_conversation_id, '') is not null or lt && array['kapso', 'whatsapp'] then 'chatbot'");
    expect(sql).toContain("else 'otro'");
    for (const option of SALES_CHANNEL_OPTIONS) expect(sql).toContain(`'${option.value}'`);
  });
  it("el filtro «Canal» del Master: URL, servidor y navegador", () => {
    const q = parseMasterQuery(new URLSearchParams("cn=asesora,chatbot"));
    expect([...q.filters.salesChannels]).toEqual(["asesora", "chatbot"]);
    const f = emptyFilters();
    f.salesChannels = new Set(["web_formulario"]);
    expect(buildMasterQuery({ filters: f, sortKey: "created", page: 1 }).toString()).toBe("cn=web_formulario");
    const row = (sales_channel: string | null) => ({ sales_channel } as unknown as OrderMasterRow);
    expect(matchesFilters(row("web_formulario"), f, new Date().toISOString())).toBe(true);
    expect(matchesFilters(row("asesora"), f, new Date().toISOString())).toBe(false);
    expect(read("lib/orders-master-access.ts")).toContain('if (f.salesChannels.size) q = q.in("sales_channel", [...f.salesChannels]);');
    expect(read("lib/order-master.ts")).toContain("sales_channel: salesChannel(order.tags, order.kapso_conversation_id),");
  });
  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Canal de venta (15-10-2026).**");
    expect(mom).toContain("Un pedido tiene un solo canal");
  });
});
