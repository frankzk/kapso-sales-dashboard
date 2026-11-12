// Lista negra automática (C): rechazó en la puerta y nunca recibió (owner
// 12-11-2026, 0333). En Lima un rechazo termina «anulado» y no entraba: había
// 135 clientes de Lima que rechazaron y solo 1 estaba en la lista.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPagoOnlineReason, pagoOnlineListOf, pagoOnlineMotivo, pagoOnlineReasonOf, type PagoOnlineOrderFact } from "@/lib/pago-online";
import { lnMotivo } from "@/lib/lista-negra-copy";

const read = (p: string) => readFileSync(p, "utf8");
const o = (phone: string, coverage: string, status: string, rejected = false): PagoOnlineOrderFact => ({
  customer_phone: phone, coverage, general_status: status, door_rejected: rejected,
});

describe("rechazó en la puerta y nunca recibió", () => {
  it("un rechazo en Lima, aunque termine anulado o siga en reprogramación, entra", () => {
    expect(pagoOnlineListOf([o("51987000001", "lima", "anulado", true)])).toEqual([{ phone: "987000001", reason: "rechazo", failed: 1, orders: 1 }]);
    expect(pagoOnlineListOf([o("987000002", "lima", "en_proceso", true), o("987000002", "lima", "anulado", true)]))
      .toEqual([{ phone: "987000002", reason: "rechazo", failed: 2, orders: 2 }]);
  });

  it("si recibió algo, no entra; el devuelto manda sobre el rechazo y el rechazo sobre el anulador", () => {
    expect(pagoOnlineListOf([o("987000003", "lima", "anulado", true), o("987000003", "agencia", "entregado")])).toEqual([]);
    expect(pagoOnlineListOf([o("987000004", "provincia_cod", "devuelto", true)])).toEqual([{ phone: "987000004", reason: "devuelto", failed: 1, orders: 1 }]);
    expect(pagoOnlineReasonOf({ orders: 5, devueltos: 0, anulados: 5, received: 0, rechazos: 1 })).toBe("rechazo");
    expect(pagoOnlineReasonOf({ orders: 5, devueltos: 0, anulados: 5, received: 0 })).toBe("anulador");
  });

  it("el motivo es explícito", () => {
    expect(isPagoOnlineReason("rechazo")).toBe(true);
    expect(pagoOnlineMotivo({ reason: "rechazo", failed: 1, orders: 3 })).toBe("Rechazó 1 pedido en la puerta y nunca recibió");
    expect(lnMotivo({ kind: "rechazo", n: 2 })).toBe("Rechazó 2 pedidos en la puerta y nunca recibió");
  });

  it("la 0333 cuenta los dos hechos de rechazo y guarda el motivo y la cuenta", () => {
    const sql = read("db/migrations/0333_lista_negra_rechazo.sql");
    expect(sql).toContain("ev.kind = 'stop_reported' and ev.payload->>'outcome_reason' = 'rechazado'");
    expect(sql).toContain("upper(btrim(split_part(coalesce(sh.reported_status, ''), ' · ', 1))) = 'REFUSED'");
    expect(sql).toContain("check (reason in ('devuelto', 'anulador', 'rechazo'))");
    expect(sql).toMatch(/when h\.devueltos >= 1 then 'devuelto'\s+when h\.rechazos >= 1 then 'rechazo'\s+else 'anulador'/);
    expect(sql).toContain("'rechazos', v_rech");
    expect(read("lib/pago-online-server.ts")).toContain("rechazos: counts.rechazos,");
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**(C) Rechazó en la puerta (12-11-2026).**");
  });
});
