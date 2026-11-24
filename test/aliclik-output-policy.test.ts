import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Alexis tiene la caja HOY: sin reporte desde un día anterior ya no sería activa (owner, 23-11-2026, `salidaActiva`).
const HOY = new Date().toISOString();
import { aliclikOutputPolicy, type AliclikExistingOutput } from "@/lib/aliclik-output-policy";

// KP200077: Alexis conserva la primera caja y todavía no reportó un resultado.
const alexis: AliclikExistingOutput = Object.freeze({
  id: "gf-output", courier: "propio",
  guide_code: "MOM-KP200077-PROPIO-EBFFA4E4", output_code: "KP200077-S01",
  delivery_status: "pendiente", created_via: "grupo_gf_courier",
  custody_state: "courier", custody_transferred_at: HOY,
});
const decide = (outputs: AliclikExistingOutput[], motivo: string | null = null,
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida" = "lima", manual = true) =>
  aliclikOutputPolicy({ outputs, operation, motivo, manual });

describe("Aliclik proactivo en Lima", () => {
  it("con Alexis sin reporte pide motivo, y con motivo permite otra salida independiente", () => {
    const without = decide([alexis]);
    expect(without.ok).toBe(false);
    if (!without.ok) {
      expect(without.pideMotivo).toBe(true);
      expect(without.error).toContain("Grupo GF Courier");
      expect(without.error).toContain("KP200077-S01");
      expect(without.error).toContain("sin esperar su reporte");
    }
    const allowed = decide([alexis], " Preparar Aliclik mientras Alexis sigue sin reporte. ");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.motivo).toBe("Preparar Aliclik mientras Alexis sigue sin reporte.");
      expect(allowed.estorban).toEqual([alexis]);
    }
    expect(alexis.custody_state).toBe("courier");
    expect(alexis.delivery_status).toBe("pendiente");
    expect(alexis.custody_transferred_at).toBe(HOY);
  });

  it("un motivo vacío no permite emitir", () => {
    expect(decide([alexis], "   ").ok).toBe(false);
  });

  it("también permite preparar con otro courier en ruta, conservando todas las salidas en la evidencia", () => {
    // En ruta HOY: sin reporte desde un día anterior ya no sería activa (owner, 23-11-2026, `salidaActiva`).
    const second = { ...alexis, id: "other", courier: "axel", delivery_status: "en_ruta", custody_transferred_at: new Date().toISOString() };
    const result = decide([alexis, second], "La clienta pidió otra fecha.");
    expect(result.ok).toBe(true);
    expect(result.estorban).toHaveLength(2);
  });

  it.each(["provincia_cod", "agencia", "desconocida"] as const)(
    "fuera de Lima conserva el bloqueo aunque se mande un motivo: %s", (operation) => {
      const result = decide([alexis], "Quiero otra", operation);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.pideMotivo).toBe(false);
    },
  );

  it("el automático no puede justificar otra salida en nombre de una persona", () => {
    expect(decide([alexis], "motivo enviado", "lima", false).ok).toBe(false);
    expect(decide([], null, "lima", false).ok).toBe(true);
  });

  it("una Aliclik que ya está activa no admite otra aunque haya motivo", () => {
    const result = decide([{ ...alexis, courier: "aliclik" }], "duplicar");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pideMotivo).toBe(false);
  });

  it("si Alexis reporta entrega, el motivo no permite emitir la siguiente", () => {
    const result = decide([{ ...alexis, delivery_status: "entregado" }], "preparar");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("entregada");
  });

  it("cuenta las cinco salidas aunque ya estén cerradas", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...alexis, id: String(i), delivery_status: "anulado" }));
    const result = decide(five, "otra");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("máximo de 5");
  });

  it("una por definir se rellena y no consume una sexta salida", () => {
    const placeholder = { ...alexis, id: "placeholder", courier: "por_definir", created_via: "mom_manual_route",
      custody_state: "empresa", custody_transferred_at: null };
    const closed = Array.from({ length: 3 }, (_, i) => ({ ...alexis, id: `closed-${i}`, delivery_status: "anulado" }));
    expect(decide([alexis, ...closed, placeholder], "Preparar para mañana").ok).toBe(true);
    expect(decide([alexis, ...closed, { ...placeholder, custody_state: "courier" }], "otra").ok).toBe(false);
  });

  it("conserva la excepción de Swayp en devolución, también en provincia", () => {
    const swayp = { ...alexis, courier: "fenix", swayp_state: 8, delivery_status: "en_ruta" };
    expect(decide([swayp], null, "provincia_cod").ok).toBe(true);
    expect(decide([{ ...swayp, swayp_state: 6 }], null, "provincia_cod").ok).toBe(false);
  });
});

describe("GF Courier → Aliclik: Kapta anula la guía GF (owner, 15-11-2026)", () => {
  // «Kapta la anula sola. Pero el límite sería si ya se asignó: no crea la de
  // Aliclik. Si la prepararon y aún no se asigna a motorizado, se puede anular.»
  const gf = (deliveryStatus: string): AliclikExistingOutput => ({
    id: `gf-${deliveryStatus}`, courier: "gf_courier", guide_code: "GF26AF62464D9F42F7", output_code: "AUR900859-S01",
    delivery_status: deliveryStatus, created_via: "gf_courier_api", custody_state: "empresa", custody_transferred_at: null,
  });
  const byPerson = (outputs: AliclikExistingOutput[]) =>
    aliclikOutputPolicy({ outputs, operation: "lima", motivo: null, manual: true, person: true });

  it("creada o preparada sin asignar: una persona crea Aliclik sin motivo y la GF va a anularse", () => {
    const result = byPerson([gf("pendiente")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gfToCancel?.map((o) => o.guide_code)).toEqual(["GF26AF62464D9F42F7"]);
      expect(result.motivo).toBeNull();
    }
  });

  it("asignada a motorizado (en ruta): no se crea la de Aliclik", () => {
    const result = byPerson([gf("en_ruta")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.pideMotivo).toBe(false);
      expect(result.error).toContain("ya asignó el pedido a un motorizado");
      expect(result.error).toContain("GF26AF62464D9F42F7");
    }
  });

  it("el automático no anula la guía GF de nadie, ni el reintento de Lima con su motivo", () => {
    const result = aliclikOutputPolicy({ outputs: [gf("pendiente")], operation: "lima", motivo: "reintento", manual: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("El automático no la anula");
  });

  it("una GF cerrada no se anula ni estorba", () => {
    const result = byPerson([gf("anulado")]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.gfToCancel).toBeUndefined();
  });

  it("la creación anula la GF después de las compuertas y antes del candado, y lo dice si Aliclik falla", () => {
    const src = readFileSync(join(process.cwd(), "lib/aliclik-guide.ts"), "utf8");
    const cancel = src.indexOf("finalOutputPolicy.gfToCancel");
    expect(cancel).toBeGreaterThan(src.indexOf("const finalOutputPolicy = await readAliclikOutputPolicy"));
    expect(cancel).toBeLessThan(src.indexOf('.from("aliclik_order_requests")\n    .insert('));
    expect(src).toContain("No se creó la guía de Aliclik.");
    expect(src).toContain("person: Boolean(ctx.userId) && !origin");
    expect(src).toContain("${res.error}${gfNote}");
  });

  // #KP206846, #KP206937, #KP206970 (owner, 24-11-2026): la guía GF volvió por «no contesta» y quedó guardada en el
  // almacén de GF. Ya no es una salida activa: no frena a Aliclik, y Kapta la anula en GF después de crear la de
  // Aliclik, sin frenar si GF no puede.
  const noContesta: AliclikExistingOutput = {
    id: "gf-no-contesta", courier: "gf_courier", guide_code: "KENKU-KP206937", output_code: "KP206937-S01",
    delivery_status: "pendiente", created_via: "gf_courier_api", custody_state: "courier",
    custody_transferred_at: "2026-11-17T22:37:26.117+00:00", dispatched_at: "2026-11-17T22:37:26.117+00:00",
    reported_status: "INCIDENT:NO_ANSWER", last_courier_change_at: "2026-11-18T16:48:55.166+00:00",
  } as AliclikExistingOutput;

  it("GF con «no contesta»: una persona crea Aliclik sin motivo y la GF se intenta anular después", () => {
    const result = byPerson([noContesta]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gfToCancel).toBeUndefined();
      expect(result.gfToTry?.map((o) => o.guide_code)).toEqual(["KENKU-KP206937"]);
      expect(result.motivo).toBeNull();
    }
    const auto = aliclikOutputPolicy({ outputs: [noContesta], operation: "lima", motivo: null, manual: false });
    expect(auto.ok && auto.gfToTry).toBeFalsy();
  });

  it("la GF que no frena se anula con la guía de Aliclik ya creada, y nunca la deshace", () => {
    const src = readFileSync(join(process.cwd(), "lib/aliclik-guide.ts"), "utf8");
    const tried = src.indexOf("cancelInactiveGfGuides(admin, orderId, finalOutputPolicy.gfToTry");
    expect(tried).toBeGreaterThan(src.indexOf('if ("error" in written)'));
    expect(tried).toBeLessThan(src.indexOf("await recomputeOrderMasterSafe(admin, [orderId]);\n  return {\n    orderNumber,"));
    const helper = readFileSync(join(process.cwd(), "lib/gf-courier-guide.ts"), "utf8");
    expect(helper).toContain("sigue abierta en GF (la caja no ha vuelto a su almacén)");
    expect(helper).toContain("if (!salidaActiva(gf as unknown as SalidaExistente)) { inactive.push(gf); continue; }");
  });
});
