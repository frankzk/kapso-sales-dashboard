// Vigía del buzón (MOM §16.2, 14-11-2026): cuándo una fuente de correo está
// callada y qué dice el aviso.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOX_SOURCES, formatInboxAlert, inboxStatus, limaShort } from "@/lib/inbox-watch";

const now = new Date("2026-11-14T13:23:00Z"); // sáb 14, 8:23 de Lima
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

describe("inboxStatus", () => {
  it("umbrales: Yape a las 30 horas, Olva a las 60", () => {
    expect(INBOX_SOURCES.yape.staleHours).toBe(30);
    expect(INBOX_SOURCES.olva.staleHours).toBe(60);
    const s = inboxStatus({ yape: hoursAgo(29.9), olva: hoursAgo(59) }, now);
    expect(s.map((x) => x.stale)).toEqual([false, false]);
    const t = inboxStatus({ yape: hoursAgo(30), olva: hoursAgo(60) }, now);
    expect(t.map((x) => x.stale)).toEqual([true, true]);
  });

  it("una noche y un fin de semana normales no avisan", () => {
    // Yape: hasta 24 h de noche o en domingo. Olva: de sábado a lunes, 52 h.
    const s = inboxStatus({ yape: hoursAgo(24), olva: hoursAgo(52) }, now);
    expect(s.every((x) => !x.stale)).toBe(true);
  });

  it("sin nada recibido nunca no avisa: es una fuente sin configurar", () => {
    const s = inboxStatus({ yape: null, olva: undefined }, now);
    expect(s).toEqual([
      { source: "yape", lastAt: null, hours: null, stale: false },
      { source: "olva", lastAt: null, hours: null, stale: false },
    ]);
  });
});

describe("formatInboxAlert", () => {
  it("nada callado, nada que mandar", () => {
    expect(formatInboxAlert(inboxStatus({ yape: hoursAgo(2), olva: hoursAgo(5) }, now))).toBeNull();
  });

  it("el caso del 09-11 al 13-11: dice qué fuente, desde cuándo y cómo se arregla", () => {
    const text = formatInboxAlert(inboxStatus({ yape: "2026-11-09T17:39:54Z", olva: hoursAgo(10) }, now))!;
    expect(text).toContain("Reportes de movimientos de Yape: el último llegó hace 115 h (lun 9, 12:39)");
    expect(text).not.toContain("Rótulos de Olva");
    expect(text).toContain("«Outlook monono.pe (rótulos Olva)» → Reauthorize");
    expect(text).toContain("«Kapta · Estado de cuenta Yape (Outlook → Kapta)»");
    expect(text).toContain("quedan en «Pendiente de revisión»");
  });

  it("las dos calladas: los dos escenarios, y el aviso de Yape solo si Yape está", () => {
    const both = formatInboxAlert(inboxStatus({ yape: hoursAgo(40), olva: hoursAgo(70) }, now))!;
    expect(both).toContain("«Kapta · Estado de cuenta Yape (Outlook → Kapta)» y «Kapta · Rótulos de Olva (Outlook → Kapta)»");
    const olva = formatInboxAlert(inboxStatus({ yape: hoursAgo(1), olva: hoursAgo(70) }, now))!;
    expect(olva).not.toContain("Pendiente de revisión");
  });

  it("la hora va en Lima", () => {
    expect(limaShort("2026-11-13T21:29:55Z")).toBe("vie 13, 16:29");
  });
});

describe("el cron", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/cron/inbox-watch/route.ts"), "utf8");
  const vercel = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };

  it("corre a las 8:23, 13:23 y 18:23 de Lima, nunca de noche", () => {
    expect(vercel.crons.find((c) => c.path === "/api/cron/inbox-watch")?.schedule).toBe("23 13,18,23 * * *");
  });

  it("los recruces no cuentan como correo, y avisa una vez por chat", () => {
    expect(route).toContain('q.not("message_id", "like", "recruce:%")');
    expect(route).toContain("if (sentTo.has(chatId)) continue;");
    expect(route).toContain("internalAuthorized(req)");
  });
});
