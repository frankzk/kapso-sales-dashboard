import { describe, expect, it } from "vitest";
import {
  displayAccount,
  formatTransferAccounts,
  primaryYape,
  rowToPaymentMethod,
  yapeNumberParam,
  yapeQuickReply,
  type PaymentMethod,
} from "@/lib/payment-methods";

// Las siete cuentas tal como las dictó el negocio el 15-09-2026, en el orden
// en que quiere que se lean. Son la semilla de la migración 0166.
function seed(): PaymentMethod[] {
  const mk = (
    over: Partial<PaymentMethod> & Pick<PaymentMethod, "kind" | "label" | "holder" | "account" | "sort">,
  ): PaymentMethod => ({
    id: over.label,
    detail: null,
    primaryYape: false,
    active: true,
    ...over,
  });
  return [
    mk({ kind: "banco", label: "BCP", holder: "Grupo GF SAC", account: "191-2434540-0-12", detail: "CUENTA CORRIENTE BCP SOLES", sort: 10 }),
    mk({ kind: "banco", label: "BBVA", holder: "Frankz Kastner", account: "0011-0179-0200429111", detail: "BBVA CUENTA FACIL", sort: 20 }),
    mk({ kind: "banco", label: "SCOTIABANK", holder: "Frankz Kastner", account: "005-7509762", sort: 30 }),
    mk({ kind: "banco", label: "INTERBANK", holder: "Frankz Kastner", account: "6433195481731", sort: 40 }),
    mk({ kind: "yape", label: "YAPE 1", holder: "Grupo GF SAC", account: "930555309", primaryYape: true, sort: 50 }),
    mk({ kind: "billetera", label: "LUKITA - PLIN - AGORA", holder: "Frankz Kastner", account: "965391481", sort: 60 }),
    mk({ kind: "yape", label: "YAPE 2 o PLIN", holder: "Gabriela Reaño", account: "987754147", sort: 70 }),
  ];
}

describe("displayAccount", () => {
  it("parte un celular peruano en tres grupos, y deja el resto tal cual", () => {
    expect(displayAccount("930555309")).toBe("930 555 309");
    expect(displayAccount("930 555 309")).toBe("930 555 309");
    // Una cuenta bancaria con guiones no es un celular.
    expect(displayAccount("191-2434540-0-12")).toBe("191-2434540-0-12");
    expect(displayAccount("6433195481731")).toBe("6433195481731");
  });
});

describe("primaryYape", () => {
  it("es la marcada como principal", () => {
    expect(primaryYape(seed())?.label).toBe("YAPE 1");
  });

  it("sin marca cae al primer Yape activo, y sin Yape no hay nada", () => {
    const sinMarca = seed().map((m) => ({ ...m, primaryYape: false }));
    expect(primaryYape(sinMarca)?.label).toBe("YAPE 1");
    // Un Yape RETIRADO no cuenta aunque siga marcado: el botón no puede
    // contestar una cuenta que dejó de usarse.
    const retirado = seed().map((m) => (m.label === "YAPE 1" ? { ...m, active: false } : m));
    expect(primaryYape(retirado)?.label).toBe("YAPE 2 o PLIN");
    expect(primaryYape(seed().filter((m) => m.kind !== "yape"))).toBeNull();
  });
});

describe("lo que contesta cada botón", () => {
  it("Yape: una sola línea para copiar de un vistazo", () => {
    expect(yapeQuickReply(seed())).toBe("YAPE GRUPO GF SAC 930 555 309");
    expect(yapeNumberParam(seed())).toBe("930 555 309");
    expect(yapeQuickReply([])).toBeNull();
  });

  it("Transferencia: todas las cuentas activas, en orden, con el número solo en su línea", () => {
    expect(formatTransferAccounts(seed())).toBe(
      [
        "BCP: A nombre de Grupo GF SAC, CUENTA CORRIENTE BCP SOLES:\n191-2434540-0-12",
        "BBVA: A nombre de Frankz Kastner, BBVA CUENTA FACIL:\n0011-0179-0200429111",
        "SCOTIABANK: A nombre de Frankz Kastner:\n005-7509762",
        "INTERBANK: A nombre de Frankz Kastner:\n6433195481731",
        "YAPE 1: A nombre de Grupo GF SAC:\n930 555 309",
        "LUKITA - PLIN - AGORA: A nombre de Frankz Kastner:\n965 391 481",
        "YAPE 2 o PLIN: A nombre de Gabriela Reaño:\n987 754 147",
      ].join("\n\n"),
    );
  });

  it("las retiradas no salen, y sin ninguna activa no hay mensaje", () => {
    const soloBcp = seed().map((m) => ({ ...m, active: m.label === "BCP" }));
    expect(formatTransferAccounts(soloBcp)).toBe(
      "BCP: A nombre de Grupo GF SAC, CUENTA CORRIENTE BCP SOLES:\n191-2434540-0-12",
    );
    expect(formatTransferAccounts(seed().map((m) => ({ ...m, active: false })))).toBeNull();
  });
});

describe("rowToPaymentMethod", () => {
  it("un tipo desconocido en la base no revienta la lista: cae a banco", () => {
    const m = rowToPaymentMethod({
      id: "x",
      kind: "cripto",
      label: "L",
      holder: "H",
      account: "1",
      detail: null,
      primary_yape: false,
      active: true,
      sort: 0,
    });
    expect(m.kind).toBe("banco");
  });
});
