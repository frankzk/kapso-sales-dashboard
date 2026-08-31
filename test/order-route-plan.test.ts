import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOrderRoutePlan } from "@/lib/order-route-plan";

const grupoGfDisponible = {
  known: true,
  eligible: true,
  reason: "Tarifa S/ 13.00 incluida IGV.",
  districtKey: "san miguel",
  agreementId: "agreement-1",
  tariffAmount: 13,
  currency: "PEN",
  sameDayCutoff: "11:30",
} as const;

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

  it("muestra Grupo GF Courier para un pedido Lima elegible", () => {
    const plan = buildOrderRoutePlan({
      operation: "lima",
      outputs: [],
      grupoGfCourier: grupoGfDisponible,
      // 10:00 en Lima: todavía entra al corte de 11:30.
      now: new Date("2026-08-31T15:00:00Z"),
    });
    const grupoGf = plan.candidates.find((route) => route.key === "propio");
    expect(grupoGf).toMatchObject({
      label: "Grupo GF Courier",
      availability: "available",
      recommended: true,
    });
    expect(grupoGf?.timing).toContain("corte 11:30");
    expect(grupoGf?.reason).toContain("S/ 13.00");
  });

  it("explica por qué Grupo GF no es elegible y recomienda otra ruta", () => {
    const plan = buildOrderRoutePlan({
      operation: "lima",
      outputs: [],
      grupoGfCourier: {
        ...grupoGfDisponible,
        eligible: false,
        tariffAmount: null,
        reason: "Sin tarifa configurada para este distrito.",
      },
      now: new Date("2026-08-31T15:00:00Z"),
    });
    const grupoGf = plan.candidates.find((route) => route.key === "propio");
    expect(grupoGf?.availability).toBe("blocked");
    expect(grupoGf?.reason).toContain("Sin tarifa");
    expect(plan.candidates.find((route) => route.recommended)?.key).toBe("axel");
  });

  it("Grupo GF Courier no aparece fuera de Lima Metropolitana y Callao", () => {
    for (const operation of ["provincia_cod", "agencia"] as const) {
      const plan = buildOrderRoutePlan({
        operation,
        outputs: [],
        grupoGfCourier: grupoGfDisponible,
      });
      expect(plan.candidates.some((route) => route.key === "propio")).toBe(false);
    }
  });

  it("una salida propia histórica bloquea una segunda salida Grupo GF activa", () => {
    const plan = buildOrderRoutePlan({
      operation: "lima",
      outputs: [{ id: "legacy-1", courier: "propio", deliveryStatus: "pendiente" }],
      grupoGfCourier: grupoGfDisponible,
    });
    const grupoGf = plan.candidates.find((route) => route.key === "propio");
    expect(grupoGf?.availability).toBe("blocked");
    expect(grupoGf?.reason).toContain("salida activa");
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
    expect(aliclik?.blockingOutput?.guideCode).toBe("AUR5X040110019435");
  });

  it("no inventa código cuando la guía activa no tiene uno", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente" }],
    });
    const shalom = plan.candidates.find((route) => route.key === "shalom");
    expect(shalom?.availability).toBe("blocked");
    // La salida se nombra igual —hay una y bloquea—, pero sin número inventado.
    expect(shalom?.blockingOutput?.guideCode ?? null).toBeNull();
  });

  it("entre varias activas prefiere la última que TENGA número", () => {
    // Una salida sin código no sirve para ir a buscarla al panel del courier,
    // que es exactamente para lo que se enseña.
    const plan = buildOrderRoutePlan({
      operation: "provincia_cod",
      outputs: [
        { id: "g1", courier: "aliclik", deliveryStatus: "en_ruta", guideCode: "AUR5X001" },
        { id: "g2", courier: "aliclik", deliveryStatus: "en_ruta", guideCode: null },
      ],
    });
    expect(
      plan.candidates.find((route) => route.key === "aliclik")?.blockingOutput?.guideCode,
    ).toBe("AUR5X001");
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

  it("nombra la salida que bloquea, no solo dice que existe", () => {
    // «No disponible» a secas obliga a bajar hasta «Salidas y guías» para saber
    // de cuál se habla, y en el panel de Shalom hay que buscarla por su número.
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [
        {
          id: "g1",
          courier: "shalom",
          deliveryStatus: "pendiente",
          guideCode: "90484166",
          shortCode: "MCMH",
          pickupState: "pendiente_de_envio",
        },
      ],
    });
    expect(plan.candidates.find((route) => route.key === "shalom")?.blockingOutput).toEqual({
      id: "g1",
      guideCode: "90484166",
      shortCode: "MCMH",
      deliveryStatus: "pendiente",
      pickupState: "pendiente_de_envio",
    });
  });

  it("una ruta libre no arrastra la identidad de otra", () => {
    // La tarjeta usa `blockingOutput` para decidir si pinta la ficha: si Olva
    // heredara la de Shalom, diría que ya tiene una salida que no es suya.
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente", guideCode: "9048" }],
    });
    expect(plan.candidates.find((route) => route.key === "olva")?.blockingOutput ?? null).toBeNull();
  });

  it("un bloqueo por tope de salidas no finge una salida que bloquea", () => {
    // Ahí no hay una guía concreta que anular: el límite es del pedido entero.
    const outputs = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      courier: "axel",
      deliveryStatus: "anulado",
    }));
    const plan = buildOrderRoutePlan({ operation: "lima", outputs });
    expect(plan.candidates.every((route) => !route.blockingOutput)).toBe(true);
  });

  it("bloquea el courier ocupado sin arrastrar a los demás", () => {
    const plan = buildOrderRoutePlan({
      operation: "agencia",
      outputs: [{ id: "g1", courier: "shalom", deliveryStatus: "pendiente" }],
    });
    expect(plan.candidates.find((route) => route.key === "olva")?.availability).not.toBe("blocked");
  });
});

describe("el aviso de la mesa distingue la salida que estorba de la que se rellena", () => {
  // POR QUÉ. Una salida «por definir» no impide nada: crear la guía del courier
  // la RELLENA en vez de abrir otra. El aviso decía «una salida adicional exige
  // motivo y seguimiento independiente» sobre ella — describía el mundo anterior
  // al relleno y frenaba justo en el caso que ya no tiene problema. Pasó en
  // #KP128892: había que preguntar si crear en Tanders duplicaba la salida.

  const porDefinir = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    courier: "por_definir",
    createdVia: "mom_manual_route",
    deliveryStatus: "pendiente",
    custodyState: "empresa",
    custodyTransferredAt: null,
    outputCode: "KP128892-S01",
    outputNumber: 1,
    ...over,
  });

  const avisos = (outputs: Parameters<typeof buildOrderRoutePlan>[0]["outputs"]) =>
    buildOrderRoutePlan({ operation: "lima", outputs }).warnings.join(" ");

  it("una salida por definir NO advierte de salida adicional", () => {
    const texto = avisos([porDefinir()]);
    expect(texto).not.toContain("salida adicional");
    expect(texto).toContain("KP128892-S01");
    expect(texto).toContain("sin abrir otra");
  });

  it("una guía de courier viva SÍ sigue advirtiendo", () => {
    // El aviso no desaparece: sigue siendo verdad cuando hay un paquete en la
    // calle, que es para lo que se escribió.
    const texto = avisos([{ id: "g1", courier: "tanders", deliveryStatus: "en_ruta" }]);
    expect(texto).toContain("salida adicional exige motivo");
  });

  it("con las dos, cuenta solo la que estorba", () => {
    // Decir «2 salidas siguen activas» mezclaría una caja en la calle con una
    // caja en el almacén esperando courier. Solo una de las dos exige motivo.
    const texto = avisos([porDefinir(), { id: "g1", courier: "tanders", deliveryStatus: "en_ruta" }]);
    expect(texto).toContain("1 salida sigue activa");
    expect(texto).toContain("KP128892-S01");
  });

  it("si la caja ya salió con el motorizado, vuelve a advertir", () => {
    // Ahí sí se creará una salida nueva: hay un paquete en la calle y rellenar
    // su fila lo borraría del seguimiento.
    for (const salida of [
      porDefinir({ custodyTransferredAt: "2026-08-18T10:00:00Z" }),
      porDefinir({ custodyState: "motorizado" }),
    ]) {
      const texto = avisos([salida]);
      expect(texto).toContain("salida adicional exige motivo");
      expect(texto).not.toContain("sin abrir otra");
    }
  });

  it("nombra la salida de consecutivo más alto, que es la que se rellena", () => {
    // Misma regla que `pickFillableRouteOutput`: es la última creada, o sea la
    // caja que el almacén tiene delante. Nombrar otra mandaría a rotular mal.
    const texto = avisos([
      porDefinir({ id: "a", outputCode: "KP128892-S01", outputNumber: 1 }),
      porDefinir({ id: "b", outputCode: "KP128892-S03", outputNumber: 3 }),
      porDefinir({ id: "c", outputCode: "KP128892-S02", outputNumber: 2 }),
    ]);
    expect(texto).toContain("3 salidas por definir");
    expect(texto).toContain("KP128892-S03");
  });

  it("sin código de salida el aviso sigue siendo legible", () => {
    expect(avisos([porDefinir({ outputCode: null })])).toContain("La salida está por definir");
  });

  it("una salida sin `createdVia` no se da por rellenable", () => {
    // Es el caso de las guías que emite el courier del otro lado: escribirles
    // encima dejaría su guía viva allá y otra distinta acá. Ante la duda, avisa.
    const texto = avisos([porDefinir({ createdVia: null })]);
    expect(texto).toContain("salida adicional exige motivo");
  });

  it("el Master pasa de verdad los cuatro campos que deciden el aviso", () => {
    // Las pruebas de arriba llaman a `buildOrderRoutePlan` directamente, así que
    // no verían que el ÚNICO llamador real dejara de mandar `createdVia`. Y no
    // rompería nada visible: los campos son opcionales, la salida dejaría de
    // parecer rellenable y el aviso volvería a advertir de una salida adicional
    // que no se va a crear — el bug que esto arregla, reaparecido en silencio.
    const source = readFileSync(resolve(process.cwd(), "lib/orders-master-access.ts"), "utf8");
    const start = source.indexOf("routePlan: buildOrderRoutePlan({");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf("})),", start));
    for (const field of ["createdVia", "custodyTransferredAt", "outputCode", "outputNumber"]) {
      expect(block, field).toContain(`${field}:`);
    }
  });
});
