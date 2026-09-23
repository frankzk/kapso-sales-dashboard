// Liquidaciones 2 — vocabulario de estados por dominio (MOM §30.3).
import { describe, expect, it } from "vitest";
import {
  CONSOLIDADO_STATUSES,
  COURIER_EXTERNO_STATUSES,
  REPARTO_PROPIO_STATUSES,
  isOperationalCode,
  lookupFromTemplates,
  markForEffect,
  normalizeAlias,
  resolveStatus,
  suggestStatus,
} from "@/lib/sheets/statuses";
import { DOMAIN_TEMPLATES, isCuadernoSheet } from "@/lib/sheets/templates";
import { PERMISSIONS, permissionsFor } from "@/lib/permissions";

describe("normalizeAlias", () => {
  it("iguala mayúsculas, acentos, espacios y puntuación final", () => {
    expect(normalizeAlias(" reprogramado. ")).toBe("REPROGRAMADO");
    expect(normalizeAlias("En   Tránsito")).toBe("EN TRANSITO");
    expect(normalizeAlias("MAÑANA")).toBe("MANANA");
    expect(normalizeAlias(null)).toBe("");
  });
});

describe("vocabularios de plantilla", () => {
  it("cada estado equivale a un estado operativo que Kapta conoce", () => {
    for (const list of [REPARTO_PROPIO_STATUSES, COURIER_EXTERNO_STATUSES, CONSOLIDADO_STATUSES]) {
      for (const s of list) {
        expect(isOperationalCode(s.operational_status), `${s.code} → ${s.operational_status}`).toBe(true);
      }
    }
  });

  it("no hay códigos repetidos dentro de un dominio ni alias que apunten a dos estados", () => {
    for (const list of [REPARTO_PROPIO_STATUSES, COURIER_EXTERNO_STATUSES]) {
      const codes = list.map((s) => s.code);
      expect(new Set(codes).size).toBe(codes.length);
      const seen = new Map<string, string>();
      for (const s of list) {
        for (const alias of s.aliases) {
          const n = normalizeAlias(alias);
          expect(seen.get(n) ?? s.code, `alias «${n}» en ${seen.get(n)} y ${s.code}`).toBe(s.code);
          seen.set(n, s.code);
        }
      }
    }
  });

  it("solo entrega y devolución cierran; una cancelación del courier cuenta como intento", () => {
    expect(markForEffect("entrega")).toBe("E");
    expect(markForEffect("devolucion")).toBe("D");
    expect(markForEffect("informa")).toBe("T");
    expect(markForEffect("anulacion")).toBe("T");
    expect(markForEffect("sin_salida")).toBe("0");
  });

  it("los cuatro estados que explicó la operación son detalle de una no entrega", () => {
    const l = lookupFromTemplates(REPARTO_PROPIO_STATUSES);
    expect(resolveStatus("LO DEJA", l)).toMatchObject({ kind: "ok", code: "no_salio" });
    expect(resolveStatus("DESARMAR/ALEXIS", l)).toMatchObject({ kind: "ok", code: "desarmar" });
    expect(resolveStatus("dice que recibió", l)).toMatchObject({ kind: "ok", code: "ya_recibio" });
    expect(resolveStatus("REPETIDO", l)).toMatchObject({ kind: "ok", code: "repetido" });
    const by = (code: string) => REPARTO_PROPIO_STATUSES.find((s) => s.code === code)!;
    expect(by("no_salio").effect).toBe("sin_salida");
    expect(by("desarmar").effect).toBe("devolucion");
    expect(by("ya_recibio").effect).toBe("informa");
    expect(by("repetido").effect).toBe("informa");
  });

  it("los seis dominios del Excel existen y los de vocabulario lo traen", () => {
    expect(DOMAIN_TEMPLATES.map((d) => d.key)).toEqual([
      "pedidos",
      "catalogos",
      "reparto_propio",
      "courier_externo",
      "consolidado",
      "indicadores",
    ]);
    expect(DOMAIN_TEMPLATES.find((d) => d.key === "reparto_propio")?.statuses.length).toBeGreaterThan(5);
    expect(DOMAIN_TEMPLATES.find((d) => d.key === "courier_externo")?.statuses.length).toBeGreaterThan(5);
  });
});

describe("resolveStatus", () => {
  const lookup = lookupFromTemplates(REPARTO_PROPIO_STATUSES);

  it("acepta el código tal cual y los alias que escribían los motorizados", () => {
    expect(resolveStatus("entregado", lookup)).toMatchObject({ kind: "ok", code: "entregado" });
    expect(resolveStatus("NO CONFRIMO", lookup)).toMatchObject({ kind: "ok", code: "no_confirmo" });
    expect(resolveStatus("repro", lookup)).toMatchObject({ kind: "ok", code: "reprogramado" });
    expect(resolveStatus("Mañana", lookup)).toMatchObject({ kind: "ok", code: "reprogramado" });
    expect(resolveStatus("CAIDA", lookup)).toMatchObject({ kind: "ok", code: "rechazado" });
  });

  it("no adivina: un texto desconocido vuelve como alias sin equivalente", () => {
    expect(resolveStatus("KAST YAP/PLN/ETC GC", lookup)).toEqual({ kind: "unknown", alias: "KAST YAP/PLN/ETC GC" });
    expect(resolveStatus("   ", lookup)).toEqual({ kind: "empty" });
  });

  it("los alias de la hoja mandan sobre la plantilla", () => {
    const custom = { codes: lookup.codes, aliases: new Map([["OK", "reprogramado"]]) };
    expect(resolveStatus("ok", custom)).toMatchObject({ kind: "ok", code: "reprogramado" });
  });
});

describe("courier externo con cuaderno (Alexis, Urpi)", () => {
  const l = lookupFromTemplates(COURIER_EXTERNO_STATUSES);

  it("lee lo que escriben Alexis y Urpi con el vocabulario del courier", () => {
    expect(resolveStatus("CAIDA", l)).toMatchObject({ kind: "ok", code: "cancelado" });
    expect(resolveStatus("CNELADO", l)).toMatchObject({ kind: "ok", code: "cancelado" });
    expect(resolveStatus("RETIRADO", l)).toMatchObject({ kind: "ok", code: "retirado" });
    expect(resolveStatus("PROGRAMADO", l)).toMatchObject({ kind: "ok", code: "pendiente" });
    expect(resolveStatus("NO RECIBE", l)).toMatchObject({ kind: "ok", code: "no_contesta" });
    expect(resolveStatus("RE PRO", l)).toMatchObject({ kind: "ok", code: "reprogramado" });
  });

  it("una hoja es cuaderno si su dominio es de puntos o si su config lo declara", () => {
    expect(isCuadernoSheet({ config: {} }, { row_key: "punto" })).toBe(true);
    expect(isCuadernoSheet({ config: { layout: "cuaderno" } }, { row_key: "guia" })).toBe(true);
    expect(isCuadernoSheet({ config: {} }, { row_key: "guia" })).toBe(false);
    expect(isCuadernoSheet({ config: null }, { row_key: "pedido" })).toBe(false);
    expect(isCuadernoSheet(null, null)).toBe(false);
  });
});

describe("suggestStatus", () => {
  it("sugiere por familia de palabras y distingue el dominio", () => {
    expect(suggestStatus("NO CONTESTA PARA COORDINAR ENTREGA", "courier_externo")).toBe("no_contesta");
    expect(suggestStatus("NO CONTESTA", "reparto_propio")).toBe("no_responde");
    expect(suggestStatus("CANCELADO CLIENTE INDICA QUE YA NO DESEA", "courier_externo")).toBe("cancelado");
    expect(suggestStatus("caida", "reparto_propio")).toBe("rechazado");
    expect(suggestStatus("Dejado en Almacén", "courier_externo")).toBe("dejado_en_almacen");
    expect(suggestStatus("SE EMVIO", "courier_externo")).toBe("despachado");
  });

  it("«entregado» gana sobre el resto y «devuelto» solo cuando lo dice", () => {
    expect(suggestStatus("ENTREGADO - CLIENTE NO CONTESTABA", "reparto_propio")).toBe("entregado");
    expect(suggestStatus("DEVUELTO AL ORIGEN", "courier_externo")).toBe("devuelto");
    expect(suggestStatus("texto sin sentido", "courier_externo")).toBeNull();
  });
});

describe("permisos de Liquidaciones 2", () => {
  it("existen y se reparten: vendedora edita, admin y owner configuran", () => {
    expect(PERMISSIONS).toContain("sheets.edit");
    expect(PERMISSIONS).toContain("sheets.manage");
    expect(permissionsFor(["vendedora"]).has("sheets.edit")).toBe(true);
    expect(permissionsFor(["vendedora"]).has("sheets.manage")).toBe(false);
    expect(permissionsFor(["admin"]).has("sheets.manage")).toBe(true);
    expect(permissionsFor(["owner"]).has("sheets.manage")).toBe(true);
    expect(permissionsFor(["viewer"]).has("sheets.edit")).toBe(false);
  });
});
