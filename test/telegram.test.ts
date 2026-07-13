import { describe, it, expect } from "vitest";
import { sendTelegramMessage } from "@/lib/telegram";
import { formatDailySummary, limaDayBounds, type StoreDailySummary } from "@/lib/daily-summary";
import { emptyPorFuente } from "@/lib/productivity";

function fakeFetch(status: number, json: unknown, capture?: (url: string, init: any) => void) {
  return (async (url: string, init: any) => {
    capture?.(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
}

describe("sendTelegramMessage", () => {
  it("POSTs to the Bot API with chat_id + HTML text", async () => {
    let seen: { url: string; init: any } | null = null;
    const res = await sendTelegramMessage("123:ABC", "-100999", "<b>hola</b>", {
      fetchImpl: fakeFetch(200, { ok: true, result: {} }, (url, init) => {
        seen = { url, init };
      }),
    });
    expect(res).toEqual({ ok: true });
    expect(seen!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(seen!.init.method).toBe("POST");
    const body = JSON.parse(seen!.init.body);
    expect(body).toMatchObject({ chat_id: "-100999", text: "<b>hola</b>", parse_mode: "HTML" });
  });

  it("surfaces a Telegram API error (ok:false) as not-ok", async () => {
    const res = await sendTelegramMessage("t", "c", "hi", {
      fetchImpl: fakeFetch(400, { ok: false, description: "chat not found" }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("chat not found");
  });
});

describe("formatDailySummary", () => {
  const summary: StoreDailySummary = {
    totalOrders: 30,
    totalRevenue: 4430,
    advisors: [
      { userId: "u1", email: "alessandra@kapso.pe", llamadas: 10, leadsTrabajados: 25, cerrados: 21, cerradosDetalle: [], ingresos: 3180, porFuente: emptyPorFuente(), porTienda: {}, conversion: 0.84, horas: 6, dias: 1 },
      { userId: "u2", email: "rocio@kapso.pe", llamadas: 4, leadsTrabajados: 9, cerrados: 1, cerradosDetalle: [], ingresos: 800, porFuente: emptyPorFuente(), porTienda: {}, conversion: 0.11, horas: 3, dias: 1 },
    ],
    bySource: [
      { key: "meta_ad", label: "Meta Ads (campañas)", orders: 18, revenue: 2600 },
      { key: "organic", label: "Orgánico (WhatsApp)", orders: 12, revenue: 1830 },
    ],
  };

  it("renders store, totals, per-source and per-advisor lines", () => {
    const msg = formatDailySummary("Aurela", "jue 26 jun", summary, "PEN");
    expect(msg).toContain("Aurela");
    expect(msg).toContain("jue 26 jun");
    expect(msg).toContain("30"); // total orders
    expect(msg).toContain("alessandra"); // local part of the email
    expect(msg).toContain("21 ventas");
    expect(msg).toContain("1 venta"); // singular for rocío
    expect(msg).toMatch(/Por asesor/);
    expect(msg).toMatch(/Por fuente/);
    expect(msg).toContain("Meta Ads (campañas)"); // source breakdown line
    expect(msg).toContain("18 pedidos");
  });

  it("appends the bot residual so the breakdown reconciles to the total", () => {
    // 30 total − (21 + 1) advisor = 8 bot orders; 4430 − (3180 + 800) = 450 bot revenue.
    const msg = formatDailySummary("Aurela", "jue 26 jun", summary, "PEN");
    expect(msg).toContain("Bot");
    expect(msg).toContain("8 ventas");
    expect(msg).toMatch(/Bot.*8 ventas/s);
  });

  it("renders the bot residual as the only seller when no advisor closed", () => {
    // All orders closed by the bot (no human touches in the window).
    const msg = formatDailySummary("Kenku", "jue 26 jun", { totalOrders: 3, totalRevenue: 300, advisors: [], bySource: [] }, "PEN");
    expect(msg).toContain("Sin ventas"); // no advisor breakdown
    expect(msg).toContain("Bot");
    expect(msg).toContain("3 ventas");
  });

  it("omits the bot line when advisors account for every order", () => {
    const exact: StoreDailySummary = {
      totalOrders: 22,
      totalRevenue: 3980,
      advisors: summary.advisors,
      bySource: [],
    };
    const msg = formatDailySummary("Aurela", "jue 26 jun", exact, "PEN");
    expect(msg).not.toContain("Bot");
  });

  it("handles no advisor activity", () => {
    const msg = formatDailySummary("Kenku", "jue 26 jun", { totalOrders: 0, totalRevenue: 0, advisors: [], bySource: [] }, "PEN");
    expect(msg).toContain("Sin ventas");
  });
});

describe("limaDayBounds", () => {
  it("maps a Lima date to its UTC day window (UTC-5)", () => {
    const b = limaDayBounds("2026-06-26");
    expect(b.date).toBe("2026-06-26");
    expect(b.startIso).toBe("2026-06-26T05:00:00.000Z");
    expect(b.endIso).toBe("2026-06-27T05:00:00.000Z");
  });
});
