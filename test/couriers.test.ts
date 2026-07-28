import { describe, expect, it } from "vitest";
import { classifyAgencyStatus, olvaAdapter, shalomAdapter } from "@/lib/couriers/agency";
import { aliclikAdapter } from "@/lib/couriers/aliclik";
import { courierAdapter, courierLabel, detectAdapter, isAgencyAdapter } from "@/lib/couriers/registry";
import { parseCount, parseDate, parseNumber, headerKey, pick, buildLookup } from "@/lib/couriers/sheet";

describe("sheet — lectura tolerante de cabeceras", () => {
  it("normaliza acentos, mayúsculas y espacios", () => {
    expect(headerKey("  FECHA   DE  ENVÍO ")).toBe("fecha de envio");
  });

  it("busca por alias y se queda con el primer valor no vacío", () => {
    const map = buildLookup({ "N° GUÍA": "", "GUIA": "SH-100", "Estado": "En agencia" });
    expect(pick(map, ["nro guia", "guia"])).toBe("SH-100");
    expect(pick(map, ["no existe"])).toBeNull();
  });

  it("parsea montos con símbolo y coma decimal", () => {
    expect(parseNumber("S/ 12,50")).toBe(12.5);
    expect(parseNumber("18.90")).toBe(18.9);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("sin costo")).toBeNull();
  });

  it("parsea fechas en formato peruano DD/MM/YYYY, nunca mes/día", () => {
    expect(parseDate("03/07/2026")).toBe("2026-07-03T00:00:00.000Z");
    expect(parseDate("3-7-26")).toBe("2026-07-03T00:00:00.000Z");
    expect(parseDate("2026-07-03")).toBe("2026-07-03T00:00:00.000Z");
    expect(parseDate("2026-07-03 14:30")).toBe("2026-07-03T14:30:00.000Z");
  });

  it("una fecha que no se entiende es null, no una inventada", () => {
    // Estas fechas deciden si un pedido cuenta como devuelto: mejor ausente.
    expect(parseDate("la semana pasada")).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate(null)).toBeNull();
  });

  it("parseCount solo acepta enteros no negativos", () => {
    expect(parseCount("3")).toBe(3);
    expect(parseCount("0")).toBe(0);
    expect(parseCount("-1")).toBeNull();
    expect(parseCount("dos")).toBeNull();
  });
});

describe("classifyAgencyStatus — ciclo de vida de agencia (§10)", () => {
  const cases: [string, string | null, string][] = [
    ["Enviado a agencia", "enviado_a_agencia", "pendiente"],
    ["REGISTRADO EN AGENCIA", "registrado_en_agencia", "pendiente"],
    ["En tránsito hacia Huancayo", "en_transito", "en_ruta"],
    ["DISPONIBLE PARA RECOJO EN AGENCIA HUANCAYO", "disponible_para_recojo", "pendiente"],
    ["Cliente notificado por WhatsApp", "cliente_notificado", "pendiente"],
    ["Pendiente de recojo", "pendiente_de_recojo", "pendiente"],
    ["Próximo a vencer", "proximo_a_vencer", "pendiente"],
    ["Retorno iniciado", "retorno_iniciado", "pendiente"],
  ];
  for (const [text, pickup, delivery] of cases) {
    it(`"${text}" → ${pickup}`, () => {
      const s = classifyAgencyStatus(text);
      expect(s.pickup_state).toBe(pickup);
      expect(s.delivery_status).toBe(delivery);
    });
  }

  it("recogido o entregado cierra la guía como entregada", () => {
    expect(classifyAgencyStatus("RECOGIDO POR EL CLIENTE")).toEqual({
      delivery_status: "entregado",
      pickup_state: "recogido",
      returned: false,
    });
    expect(classifyAgencyStatus("Entregado conforme").delivery_status).toBe("entregado");
  });

  it("devuelto al origen marca la devolución sin cerrar la guía por su cuenta", () => {
    // El cierre como Devuelto lo decide el Master, que además exige despacho y
    // guía; aquí solo se informa el hecho.
    const s = classifyAgencyStatus("DEVUELTO AL ORIGEN");
    expect(s.returned).toBe(true);
    expect(s.delivery_status).not.toBe("entregado");
  });

  it("anulado cierra la guía", () => {
    expect(classifyAgencyStatus("Anulado por el remitente").delivery_status).toBe("anulado");
  });

  it("sin estado no inventa nada", () => {
    expect(classifyAgencyStatus(null)).toEqual({
      delivery_status: "pendiente",
      pickup_state: null,
      returned: false,
    });
  });
});

describe("adaptador de agencia", () => {
  const row = {
    "N° GUÍA": "SH-778899",
    "PEDIDO": "#KP114985",
    "DESTINATARIO": "Ana Quispe",
    "TELÉFONO": "987654321",
    "PRODUCTO": "Colágeno x2",
    "DISTRITO": "El Tambo",
    "PROVINCIA": "Huancayo",
    "DEPARTAMENTO": "Junín",
    "AGENCIA": "Shalom Huancayo",
    "ESTADO": "DISPONIBLE PARA RECOJO",
    "FECHA DE ENVÍO": "03/07/2026",
    "FECHA LLEGADA": "05/07/2026",
    "FECHA LÍMITE": "20/07/2026",
    "COSTO": "S/ 18,50",
  };

  it("traduce una fila completa al registro canónico", () => {
    const [out] = shalomAdapter.parse([row]);
    expect(out).toMatchObject({
      guide_code: "SH-778899",
      order_name: "#KP114985",
      order_name_confirmed: true,
      customer_name: "Ana Quispe",
      customer_phone: "51987654321",
      district: "El Tambo",
      province: "Huancayo",
      region: "Junín",
      agency_branch: "Shalom Huancayo",
      pickup_state: "disponible_para_recojo",
      reported_status: "DISPONIBLE PARA RECOJO",
      dispatched_at: "2026-07-03T00:00:00.000Z",
      agency_arrived_at: "2026-07-05T00:00:00.000Z",
      agency_expires_at: "2026-07-20T00:00:00.000Z",
      cost: 18.5,
    });
  });

  it("conserva la fila original para la auditoría", () => {
    const [out] = shalomAdapter.parse([row]);
    expect(out!.raw).toEqual(row);
  });

  it("descarta filas sin guía ni pedido en vez de crear guías fantasma", () => {
    expect(shalomAdapter.parse([{ ESTADO: "En tránsito" }])).toHaveLength(0);
  });

  it("una devolución sin fecha no fija returned_at", () => {
    const [out] = shalomAdapter.parse([{ ...row, ESTADO: "DEVUELTO AL ORIGEN" }]);
    expect(out!.returned_at).toBeNull();
  });

  it("una devolución con fecha sí la registra", () => {
    const [out] = shalomAdapter.parse([
      { ...row, ESTADO: "DEVUELTO AL ORIGEN", "FECHA DEVOLUCIÓN": "18/07/2026" },
    ]);
    expect(out!.returned_at).toBe("2026-07-18T00:00:00.000Z");
  });

  it("un recojo fija la fecha de cierre", () => {
    const [out] = shalomAdapter.parse([
      { ...row, ESTADO: "RECOGIDO", "FECHA RECOJO": "10/07/2026" },
    ]);
    expect(out!.delivery_status).toBe("entregado");
    expect(out!.closed_at).toBe("2026-07-10T00:00:00.000Z");
  });

  it("normaliza el nº de pedido aunque venga sin almohadilla", () => {
    const [out] = shalomAdapter.parse([{ ...row, PEDIDO: "kp114985" }]);
    expect(out!.order_name).toBe("#KP114985");
  });

  it("Olva usa el mismo formato canónico", () => {
    const [out] = olvaAdapter.parse([row]);
    expect(out!.guide_code).toBe("SH-778899");
    expect(olvaAdapter.agency).toBe(true);
  });
});

describe("registro de couriers", () => {
  it("detecta Aliclik por su guía AUR5X, esté en la columna que esté", () => {
    const rows = [{ "COLUMNA RARA": "AUR5XABC123", CLIENTE: "Ana" }];
    expect(detectAdapter(rows)?.id).toBe("aliclik");
  });

  it("detecta la agencia por su nombre y por la forma del reporte", () => {
    const rows = [
      { GUIA: "SH-1", AGENCIA: "SHALOM Huancayo", ESTADO: "Disponible para recojo" },
    ];
    expect(detectAdapter(rows)?.id).toBe("shalom");
  });

  it("un formato desconocido no se adivina", () => {
    expect(detectAdapter([{ A: "1", B: "2" }])).toBeNull();
  });

  it("resuelve adaptadores por id y expone sus etiquetas", () => {
    expect(courierAdapter("aliclik")).toBe(aliclikAdapter);
    expect(courierAdapter("inventado")).toBeNull();
    expect(courierLabel("shalom")).toBe("Shalom");
    expect(isAgencyAdapter("shalom")).toBe(true);
    expect(isAgencyAdapter("aliclik")).toBe(false);
  });
});

describe("adaptador de Aliclik", () => {
  it("reutiliza el parser existente y traduce al formato canónico", () => {
    const rows = [
      {
        "GUÍA ALICLICK": "AUR5XZZ11",
        "NOMBRE COMPLETO": "Beto Ramos",
        TELEFONO: "912345678",
        DISTRITO: "Chilca",
        PROVINCIA: "Huancayo",
        DEPARTAMENTO: "Junín",
        "ESTADO ENTREGA": "ENTREGADO",
        "NRO. INTENTOS": "2",
        NOTA: "pedido #KP998877",
      },
    ];
    const [out] = aliclikAdapter.parse(rows);
    expect(out).toMatchObject({
      guide_code: "AUR5XZZ11",
      order_name: "#KP998877",
      order_name_confirmed: true,
      customer_phone: "51912345678",
      delivery_status: "entregado",
      reported_status: "ENTREGADO",
      attempts: 2,
    });
  });
});
