import { describe, expect, it } from "vitest";
import { buildOrderRoutePlan } from "@/lib/order-route-plan";

describe("motor de rutas MOM Fase 3", () => {
  it("sugiere Aliclik primero para Provincia COD nueva", () => {
    const plan = buildOrderRoutePlan({
      operation: "provincia_cod",
      outputs: [],
      paymentState: "sin_pago",
      swayp: { known: true, covered: true, stockOk: true, city: "cusco" },
    });
    expect(plan.candidates.find((route) => route.recommended)?.key).toBe("aliclik");
    expect(plan.candidates.find((route) => route.key === "shalom")?.availability).toBe("warning");
    expect(plan.candidates.some((route) => route.key === "tanders")).toBe(false);
  });

  it("solo ofrece Tanders dentro de la operación Lima", () => {
    expect(
      buildOrderRoutePlan({ operation: "lima", outputs: [] }).candidates.some(
        (route) => route.key === "tanders",
      ),
    ).toBe(true);
    expect(
      buildOrderRoutePlan({ operation: "agencia", outputs: [] }).candidates.some(
        (route) => route.key === "tanders",
      ),
    ).toBe(false);
  });

  it("Agencia no ofrece Aliclik: van Shalom u Olva", () => {
    // El drawer decide con esto si dibuja el panel de crear guía Aliclik. Si
    // esta regla se aflojara, volvería a aparecer un formulario para crear una
    // guía de una ruta que el pedido no puede tomar.
    const plan = buildOrderRoutePlan({ operation: "agencia", outputs: [] });
    expect(plan.candidates.some((route) => route.action === "aliclik")).toBe(false);
    expect(plan.candidates.map((route) => route.key)).toEqual(["shalom", "olva"]);
  });

  it("Provincia COD y cobertura desconocida sí lo ofrecen", () => {
    // Sin geografía no se puede afirmar que sea Agencia; cerrarle Aliclik a un
    // pedido «desconocida» lo dejaría sin ninguna ruta interprovincial.
    for (const operation of ["provincia_cod", "desconocida"] as const) {
      const plan = buildOrderRoutePlan({ operation, outputs: [] });
      expect(plan.candidates.some((route) => route.action === "aliclik")).toBe(true);
    }
  });

  it("prioriza Swayp después de una salida Aliclik fallida si hay stock", () => {
    const plan = buildOrderRoutePlan({
      operation: "provincia_cod",
      outputs: [{ id: "a1", courier: "aliclik", deliveryStatus: "anulado" }],
      swayp: { known: true, covered: true, stockOk: true, city: "trujillo" },
    });
    const swayp = plan.candidates.find((route) => route.key === "swayp");
    expect(swayp?.recommended).toBe(true);
    expect(swayp?.relatedShipmentId).toBe("a1");
  });

  it("considera fallida una Aliclik pendiente cuando ya reporta intentos", () => {
    const plan = buildOrderRoutePlan({
      operation: "provincia_cod",
      outputs: [{ id: "a2", courier: "aliclik", deliveryStatus: "pendiente", attempts: 1 }],
      swayp: { known: true, covered: true, stockOk: true, city: "huancayo" },
    });
    expect(plan.candidates.find((route) => route.key === "swayp")?.recommended).toBe(true);
  });

  it("bloquea agencia hasta validar el adelanto", () => {
    const blocked = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [],
      paymentState: "adelanto_cargado",
    });
    expect(blocked.candidates.every((route) => route.availability === "warning")).toBe(true);

    const ready = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [],
      paymentState: "adelanto_validado",
    });
    expect(ready.candidates.find((route) => route.key === "shalom")?.availability).toBe("available");
  });

  it("bloquea repetir Swayp en Lima y permite repetir Axel", () => {
    const outputs = [
      { id: "s1", courier: "fenix", deliveryStatus: "anulado" },
      { id: "a1", courier: "axel", deliveryStatus: "anulado" },
    ];
    const plan = buildOrderRoutePlan({ operation: "lima", outputs });
    expect(plan.candidates.find((route) => route.key === "swayp")?.availability).toBe("blocked");
    expect(plan.candidates.find((route) => route.key === "axel")?.availability).not.toBe("blocked");
  });

  it("bloquea todas las rutas al llegar a cinco salidas", () => {
    const outputs = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      courier: "axel",
      deliveryStatus: "anulado",
    }));
    const plan = buildOrderRoutePlan({ operation: "lima", outputs });
    expect(plan.candidates.every((route) => route.availability === "blocked")).toBe(true);
    expect(plan.warnings.join(" ")).toContain("límite máximo");
  });
});

describe("una salida viva bloquea repetir ese mismo courier", () => {
  // La regla ya vivía en el sistema, pero solo en el último paso: el modal de
  // Shalom contesta "el pedido ya tiene una guía activa: …, anúlala antes de
  // crear otra". Hasta ahí, la mesa seguía enseñando "Abrir Shalom" y encima con
  // el sello de Sugerido, así que el camino recomendado terminaba en un rechazo.
  it("Shalom con guía pendiente deja de ofrecerse, y no como sugerido", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente" }],
    });
    const shalom = plan.candidates.find((route) => route.key === "shalom");
    expect(shalom?.availability).toBe("blocked");
    expect(shalom?.recommended).toBe(false);
    expect(shalom?.reason).toContain("ya tiene una salida activa");
  });

  // La mesa de ruta debe enseñar el CÓDIGO de la guía que bloquea, para ubicarla
  // sin ir a otra pestaña. Se toma la última guía activa con código.
  it("expone el código de la guía activa que bloquea el courier", () => {
    const plan = buildOrderRoutePlan({
      operation: "provincia_cod",
      outputs: [
        { id: "g1", courier: "aliclik", deliveryStatus: "en_ruta", guideCode: "AUR5X040110019435" },
      ],
    });
    const aliclik = plan.candidates.find((route) => route.key === "aliclik");
    expect(aliclik?.availability).toBe("blocked");
    expect(aliclik?.activeGuideCode).toBe("AUR5X040110019435");
  });

  it("no inventa código cuando la guía activa no tiene uno", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente" }],
    });
    const shalom = plan.candidates.find((route) => route.key === "shalom");
    expect(shalom?.availability).toBe("blocked");
    expect(shalom?.activeGuideCode ?? null).toBeNull();
  });

  // Lo importante del caso: mira ACTIVA, no "ya se usó alguna vez". Bloquear por
  // haberlo usado condenaría el pedido a no volver a salir nunca por Shalom
  // después de anular una guía — que es justo lo que manda hacer el modal.
  it("anulada o entregada NO bloquean: el pedido puede volver a salir", () => {
    for (const deliveryStatus of ["anulado", "entregado"]) {
      const plan = buildOrderRoutePlan({
        operation: "agencia",
        outputs: [{ id: "g1", courier: "shalom", deliveryStatus }],
      });
      expect(plan.candidates.find((route) => route.key === "shalom")?.availability).not.toBe(
        "blocked",
      );
    }
  });

  it("una salida devuelta tampoco bloquea, aunque su estado siga vivo", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [
        { id: "g1", courier: "shalom", deliveryStatus: "pendiente", custodyState: "devuelto" },
      ],
    });
    expect(plan.candidates.find((route) => route.key === "shalom")?.availability).not.toBe(
      "blocked",
    );
  });

  it("bloquea el courier ocupado sin arrastrar a los demás", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente" }],
    });
    expect(plan.candidates.find((route) => route.key === "olva")?.availability).not.toBe("blocked");
  });
});
