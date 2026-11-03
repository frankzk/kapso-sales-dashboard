import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractReferral, isWebButtonMessage } from "@/lib/kapso";
import { SOURCE_KEYS, SOURCE_LABEL } from "@/lib/consolidado-origen";
import { ATTRIBUTION_SOURCE_ORDER } from "@/lib/metrics";
import { SOURCE_BUCKETS, emptyPorFuente } from "@/lib/productivity";
import { SOURCE_LABEL as PRODUCTIVITY_LABEL } from "@/lib/productivity-labels";
import { SOURCE_SERIES } from "@/components/palette";

const BOTON =
  "Hola, quiero pedir SUPER HUMAN Ethiopian Black Seed Oil (60 Cápsulas). Soy de Lima / Lima / Santa Anita. https://kenku.pe/products/purely-nutrient-ethiopian-black-seed-oil/";
const inbound = (text: string, extra: Record<string, unknown> = {}) => ({ direction: "inbound", content: text, ...extra });

describe("fuente web: el botón de WhatsApp de la web de la tienda (MOM §17.4)", () => {
  it("reconoce el mensaje del botón, con o sin la ubicación", () => {
    expect(isWebButtonMessage(BOTON)).toBe(true);
    expect(isWebButtonMessage("Hola, quiero pedir AirClip 360™. https://aurela.pe/products/airclip-360/")).toBe(true);
    expect(isWebButtonMessage("Soy de Junín / Tarma / Tarma")).toBe(true);
  });

  it("no confunde otros mensajes", () => {
    expect(isWebButtonMessage("¡Hola! Quiero más información")).toBe(false);
    expect(isWebButtonMessage("Hola, quiero pedir 2")).toBe(false);
    expect(isWebButtonMessage(null)).toBe(false);
  });
});

describe("extractReferral con la fuente web", () => {
  it("el mensaje del botón es web", () => {
    expect(extractReferral([inbound(BOTON)])).toMatchObject({ source: "web", ad_id: null });
  });

  it("un anuncio de Meta gana a la web", () => {
    const anuncio = inbound(BOTON, { referral: { source_id: "123", headline: "Oferta" } });
    expect(extractReferral([anuncio])).toMatchObject({ source: "meta_ad", ad_id: "123" });
  });

  it("un enlace de Facebook gana a la web", () => {
    const fb = inbound("Hola https://kenku.pe/products/x?utm_source=facebook");
    expect(extractReferral([inbound(BOTON), fb])).toMatchObject({ source: "fb_web" });
  });

  it("lo que manda el bot no cuenta", () => {
    expect(extractReferral([{ direction: "outbound", content: BOTON }])).toBeNull();
  });
});

describe("web en todas las listas de fuentes", () => {
  it("Consolidado, Productividad y la atribución la nombran", () => {
    expect(SOURCE_KEYS).toContain("web");
    expect(SOURCE_LABEL.web.title).toBe("Web de la tienda");
    expect(ATTRIBUTION_SOURCE_ORDER).toContain("web");
    expect(SOURCE_BUCKETS).toContain("web");
    expect(emptyPorFuente().web).toEqual({ cerrados: 0, ingresos: 0 });
    expect(PRODUCTIVITY_LABEL.web).toBe("Web");
    expect(SOURCE_SERIES.web).toBe(SOURCE_SERIES.fb_web);
  });

  it("0294: conversion_por_fuente le da tasa, y el resto es la 0268", () => {
    const sql = readFileSync("db/migrations/0294_conversion_fuente_web.sql", "utf8");
    const s0268 = readFileSync("db/migrations/0268_ventas_por_origen.sql", "utf8");
    expect(sql).toContain("when b.source in ('meta_ad', 'fb_web', 'web', 'cod_cart', 'abandoned_browse') then b.source");
    const cuerpo = (s: string) => {
      const i = s.indexOf("create or replace function public.conversion_por_fuente(");
      return s
        .slice(i, s.indexOf("\n$$;", i))
        .replace(/ *-- web = [^\n]*\n/, "")
        .replace("'fb_web', 'web',", "'fb_web',");
    };
    expect(cuerpo(sql)).toBe(cuerpo(s0268));
    expect(sql).toContain("grant execute on function public.conversion_por_fuente(uuid[], date, date) to authenticated, service_role;");
  });
});
