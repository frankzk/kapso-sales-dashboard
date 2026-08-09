import { describe, it, expect } from "vitest";
import {
  parseAliclikAttempts,
  parseAliclikCoordinate,
  parseAliclikDate,
  parseAliclikRow,
  parseAliclikReport,
  isImportadoRow,
  normalizeOrderName,
} from "@/lib/aliclik-import";

describe("normalizeOrderName", () => {
  it("normalizes to #KP… form", () => {
    expect(normalizeOrderName("#KP114985")).toBe("#KP114985");
    expect(normalizeOrderName("kp114985")).toBe("#KP114985");
    expect(normalizeOrderName("  #kp114985 ")).toBe("#KP114985");
    expect(normalizeOrderName("#1001-1")).toBe("#1001-1"); // Shopify edit suffix
    expect(normalizeOrderName("")).toBe(null);
    expect(normalizeOrderName(null)).toBe(null);
  });
});

describe("parseAliclikRow", () => {
  it("reads Aliclik's NRO. INTENTOS and operative delivery date", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X120731",
      "NRO. INTENTOS": "3",
      "FECHA ENTREGA": "14/07/2026",
    });
    expect(row.aliclik_attempts).toBe(3);
    expect(row.aliclik_service_date).toBe("2026-07-14");
  });

  it("normalizes Excel ISO dates and rejects invalid source values", () => {
    expect(parseAliclikDate("2026-07-18T00:00:00.000Z")).toBe("2026-07-18");
    expect(parseAliclikDate("18/07/26")).toBe("2026-07-18");
    expect(parseAliclikDate("31/02/2026")).toBeNull();
    expect(parseAliclikAttempts("Intento 2")).toBe(2);
    expect(parseAliclikAttempts("")).toBeNull();
  });

  it("reads the full delivery destination and coordinates from Aliclik", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X763370265582",
      DIRECCION: "Av. José Gálvez 145, Urb. Miramar",
      REFERENCIA: "Puerta azul, frente al parque",
      DISTRITO: "Ilo",
      PROVINCIA: "Ilo",
      DEPARTAMENTO: "Moquegua",
      LATITUD: "-17.6468721185573",
      LONGITUD: "-71.3448429172091",
    });

    expect(row.delivery_address).toBe("Av. José Gálvez 145, Urb. Miramar");
    expect(row.delivery_reference).toBe("Puerta azul, frente al parque");
    expect(row.province).toBe("Ilo");
    expect(row.region).toBe("Moquegua");
    expect(row.latitude).toBe(-17.6468721185573);
    expect(row.longitude).toBe(-71.3448429172091);
  });

  it("accepts decimal commas and rejects coordinates outside the valid range", () => {
    expect(parseAliclikCoordinate("-16,442941896382326", "latitude")).toBeCloseTo(
      -16.442941896382326,
    );
    expect(parseAliclikCoordinate("-71,5566983697624", "longitude")).toBeCloseTo(
      -71.5566983697624,
    );
    expect(parseAliclikCoordinate("-91", "latitude")).toBeNull();
    expect(parseAliclikCoordinate("181", "longitude")).toBeNull();
    expect(parseAliclikCoordinate("sin coordenada", "latitude")).toBeNull();
  });

  it("maps the spreadsheet headers seen in the real reports", () => {
    const row = parseAliclikRow({
      PEDIDO: "#KP114985",
      TIENDA: "Kenku",
      "GUÍA ALICLICK": "AUR5X114585",
      NOMBRE: "Juani Juani",
      CELULAR: "914699634",
      DISTRITO: "Cusco",
      PRODUCTO: "SUPER HUMAN Ethiopian Black Seed Oil",
      "ESTADO DE PEDIDO": "Por devolver",
    });
    expect(row.guide_code).toBe("AUR5X114585");
    expect(row.order_name).toBe("#KP114985");
    expect(row.customer_name).toBe("Juani Juani");
    expect(row.customer_phone).toBe("51914699634"); // normalized to Peru
    expect(row.product).toContain("SUPER HUMAN");
    expect(row.district).toBe("Cusco");
    expect(row.city).toBe("cusco"); // from district when no city column
    // classification is customer-outcome centric: anything not delivered → pendiente
    expect(row.delivery_status).toBe("pendiente");
    expect(row.store_hint).toBe("Kenku");
  });

  it("prefers an explicit city/province column over district", () => {
    const row = parseAliclikRow({
      "Guia Aliclik": "AUR5X999",
      Distrito: "San Sebastián",
      Provincia: "Cusco",
      Estado: "Entregado",
    });
    expect(row.city).toBe("cusco");
    expect(row.district).toBe("San Sebastián");
  });

  it("keeps the administrative province separate from the district", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X998",
      DISTRITO: "Wanchaq",
      PROVINCIA: "Cusco",
      DEPARTAMENTO: "Cusco",
    });
    expect(row.district).toBe("Wanchaq");
    expect(row.province).toBe("Cusco");
    expect(row.city).toBe("cusco");
  });

  it("flags rows with no guide code", () => {
    const row = parseAliclikRow({ NOMBRE: "x", Estado: "Entregado" });
    expect(row.guide_code).toBe(null);
  });

  it("parses the real 'order-delivery-report' export (AUR5X en NRO. PEDIDO)", () => {
    // Real column layout: the AUR5X code lives in "NRO. PEDIDO"; the Shopify
    // order ref (#KP…) is inside "NOTA"; the delivery outcome in "ESTADO ENTREGA".
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X119633",
      NOTA: "#KP115879 - 100 metros adelante de la plaza",
      "NOMBRE COMPLETO": "Perla Guerrero Linares",
      "TELÉFONO": "51965956470",
      PRODUCTO: "SUPER HUMAN Ethiopian Black Seed Oil",
      DISTRITO: "Cusco",
      PROVINCIA: "Cusco",
      DEPARTAMENTO: "Cusco",
      "ESTADO DESPACHO": "POR DEVOLVER",
      CANAL: "KENKU",
    });
    expect(row.guide_code).toBe("AUR5X119633"); // detected by value, not header
    expect(row.order_name).toBe("#KP115879"); // extracted from NOTA
    expect(row.customer_name).toBe("Perla Guerrero Linares");
    expect(row.customer_phone).toBe("51965956470");
    expect(row.city).toBe("cusco");
    // ESTADO DESPACHO=POR DEVOLVER (TO_RETURN): el paquete ya salió y vuelve al
    // origen — está en calle, en_ruta (En curso), no en la cola de armado.
    expect(row.delivery_status).toBe("en_ruta");
    expect(row.store_hint).toBe("KENKU");
  });

  it("treats ESTADO ENTREGA=ENTREGADO as delivered even when ESTADO DESPACHO=VALIDADO", () => {
    // A confirmed delivery only shows up in "ESTADO ENTREGA" (the despacho column
    // tops out at "validado"). This is the most common pair.
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      "ESTADO DESPACHO": "VALIDADO",
      "ESTADO ENTREGA": "ENTREGADO",
    });
    expect(row.delivery_status).toBe("entregado");
  });

  it("detects delivery via the 'ESTADO DE ENTREGA' header variant too", () => {
    // some exports name the column with "DE" — must still classify as entregado.
    expect(
      parseAliclikRow({
        "NRO. PEDIDO": "AUR5X108281725702",
        "ESTADO DESPACHO": "VALIDADO",
        "ESTADO DE ENTREGA": "ENTREGADO",
      }).delivery_status,
    ).toBe("entregado");
    // entregado closes even with a failure-branch despacho (ciclo ya finalizado)
    expect(
      parseAliclikRow({
        "NRO. PEDIDO": "AUR5X2",
        "ESTADO DESPACHO": "POR DEVOLVER",
        "ESTADO DE ENTREGA": "ENTREGADO",
      }).delivery_status,
    ).toBe("entregado");
  });

  it("resuelve el estado del trío ESTADO ENTREGA + DESPACHO de Aliclik", () => {
    const status = (entrega: string, despacho?: string) =>
      parseAliclikRow({
        "NRO. PEDIDO": "AUR5X1",
        "ESTADO ENTREGA": entrega,
        ...(despacho ? { "ESTADO DESPACHO": despacho } : {}),
      }).delivery_status;

    // Bajas: canceladas/anuladas/rechazadas cierran como anulado.
    expect(status("CANCELADO", "VALIDADO")).toBe("anulado");
    expect(status("ANULADO", "POR DEVOLVER")).toBe("anulado");
    // DEVUELTO (RETURNED) manda: el paquete volvió, se cierra aunque la entrega
    // diga NO CONTESTA o RECHAZADO.
    expect(status("NO CONTESTA", "DEVUELTO")).toBe("anulado");
    expect(status("RECHAZADO", "DEVUELTO")).toBe("anulado");

    // Siguen en calle (En curso): intentos fallidos y reprogramaciones, y todo lo
    // que ya salió del almacén.
    expect(status("NO CONTESTA", "POR DEVOLVER")).toBe("en_ruta");
    expect(status("RECHAZADO", "VALIDADO")).toBe("en_ruta");
    expect(status("REPROGRAMADO", "VALIDADO")).toBe("en_ruta");
    expect(status("POR ENTREGAR", "RECOLECTADO")).toBe("en_ruta"); // PICKED
    expect(status("POR ENTREGAR", "EN AGENCIA")).toBe("en_ruta"); // hub local

    // Aún en almacén → pendiente (Preparación / Por despachar): preparado sin
    // despachar, por preparar, o por entregar sin señal de despacho.
    expect(status("POR ENTREGAR", "VALIDADO")).toBe("pendiente"); // PREPARED
    expect(status("POR ENTREGAR", "POR PREPARAR")).toBe("pendiente"); // TO_PREPARE
    expect(status("POR ENTREGAR", "DEJADO EN ALMACÉN")).toBe("pendiente");
    expect(status("POR ENTREGAR")).toBe("pendiente"); // PENDING_DELIVERY sin despacho

    // ENTREGADO cierra por encima de cualquier despacho.
    expect(status("ENTREGADO", "POR DEVOLVER")).toBe("entregado");
  });

  it("un despacho reconocible clasifica aunque falte ESTADO ENTREGA", () => {
    const only = (despacho: string) =>
      parseAliclikRow({ "NRO. PEDIDO": "AUR5X1", "ESTADO DESPACHO": despacho }).delivery_status;
    expect(only("RECOLECTADO")).toBe("en_ruta"); // PICKED
    expect(only("REMANENTE EN TRÁNSITO")).toBe("en_ruta");
    expect(only("POR PREPARAR")).toBe("pendiente"); // TO_PREPARE
    expect(only("VALIDADO")).toBe("pendiente"); // PREPARED, aún en almacén
    expect(only("DEVUELTO")).toBe("anulado"); // RETURNED
  });

  it("sin ninguna señal reconocible cae al binario histórico (pendiente)", () => {
    // Un valor que no es ni ENTREGA ni DESPACHO conocido no inventa estado.
    expect(
      parseAliclikRow({ "NRO. PEDIDO": "AUR5X1", "ESTADO DE PEDIDO": "cualquier cosa" })
        .delivery_status,
    ).toBe("pendiente");
  });

  it("extracts a bare-number NOTA token as an unconfirmed candidate (needs phone cross-check)", () => {
    const row = parseAliclikRow(
      {
        "NRO. PEDIDO": "AUR5X114314",
        NOTA: "114314 - referencia",
        "TELÉFONO": "919006661",
        "ESTADO DESPACHO": "VALIDADO",
      },
      { orderPrefix: "KP" },
    );
    expect(row.guide_code).toBe("AUR5X114314");
    // no literal "KP" token → best-effort guess from the bare 6-digit run, but
    // NOT confirmed — the matcher must cross-validate it via phone before using it.
    expect(row.order_name).toBe("#KP114314");
    expect(row.order_name_confirmed).toBe(false);
    expect(row.customer_phone).toBe("51919006661");
  });

  it("matches the real report's bare-number NOTA case (e.g. '119358 -')", () => {
    const row = parseAliclikRow(
      { "NRO. PEDIDO": "AUR5X119358", NOTA: "119358 -" },
      { orderPrefix: "KP" },
    );
    expect(row.order_name).toBe("#KP119358");
    expect(row.order_name_confirmed).toBe(false);
  });

  // ── El prefijo es POR TIENDA (0115) ───────────────────────────────────────
  // Antes acá había un "#KP" fijo. Para Kenku acertaba de casualidad; para
  // Aurela fabricaba un pedido inexistente y, peor, desviaba la búsqueda del
  // auto-match a la otra tienda, porque `pickStoresForOrderQuery` enruta por el
  // prefijo. De ahí salieron 153 guías de Aurela sin enlazar durante meses.

  it("completa el número pelado con el prefijo de LA TIENDA, no con uno fijo", () => {
    const nota = { "NRO. PEDIDO": "AUR5X115389", NOTA: "115389 - referencia" };
    expect(parseAliclikRow(nota, { orderPrefix: "AUR" }).order_name).toBe("#AUR115389");
    expect(parseAliclikRow(nota, { orderPrefix: "KP" }).order_name).toBe("#KP115389");
  });

  it("sin prefijo conocido NO adivina: mejor ningún pedido que el de otra tienda", () => {
    const row = parseAliclikRow({ "NRO. PEDIDO": "AUR5X115389", NOTA: "115389 - referencia" });
    expect(row.order_name).toBeNull();
    expect(row.order_name_confirmed).toBe(false);
  });

  it("tolera que el prefijo venga con '#' o en minúsculas desde Ajustes", () => {
    const nota = { "NRO. PEDIDO": "AUR5X115389", NOTA: "115389 -" };
    expect(parseAliclikRow(nota, { orderPrefix: "#aur" }).order_name).toBe("#AUR115389");
    expect(parseAliclikRow(nota, { orderPrefix: "  " }).order_name).toBeNull();
  });

  it("un token explícito manda sobre el prefijo configurado", () => {
    // La NOTA dice "#KP115879" y la tienda es Aurela: el token gana, porque es
    // una referencia deliberada y no una conjetura.
    const row = parseAliclikRow(
      { "NRO. PEDIDO": "AUR5X1", NOTA: "#KP115879 - referencia" },
      { orderPrefix: "AUR" },
    );
    expect(row.order_name).toBe("#KP115879");
    expect(row.order_name_confirmed).toBe(true);
  });

  it("still marks a literal 'KP' token as confirmed", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      NOTA: "#KP115879 - 100 metros adelante de la plaza",
    });
    expect(row.order_name).toBe("#KP115879");
    expect(row.order_name_confirmed).toBe(true);
  });

  it("recognizes '#AUR######' (Aurela's real Shopify order.name) as confirmed", () => {
    const inNota = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X342527857589",
      NOTA: "#AUR173127 - /cliente confirma pedido en llamada>aliclick (mm",
    });
    expect(inNota.order_name).toBe("#AUR173127");
    expect(inNota.order_name_confirmed).toBe(true);

    const inOrderColumn = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X613",
      PEDIDO: "#AUR173123",
    });
    expect(inOrderColumn.order_name).toBe("#AUR173123");
    expect(inOrderColumn.order_name_confirmed).toBe(true);
  });

  it("does not mistake the guide code itself for an order reference", () => {
    // "AUR5X342527857589" has a digit ("5") then a LETTER ("X") right after
    // "AUR" — never satisfies AUR_ORDER_RE's \d{4,} requirement — and it's not
    // 6 digits alone either, so no order_name should be inferred from it.
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X342527857589",
      NOTA: "AUR5X342527857589",
    });
    expect(row.order_name).toBe(null);
  });

  it("parses a whole report", () => {
    const rows = parseAliclikReport([
      { "Guia Aliclik": "AUR5X1", Estado: "Entregado" },
      { "Guia Aliclik": "AUR5X2", Estado: "Por devolver" },
    ]);
    expect(rows.map((r) => r.delivery_status)).toEqual(["entregado", "pendiente"]);
  });
});

// Aliclik marca ESTADO LLAMADA = IMPORTADO en pedidos que subió pero todavía no
// gestiona. No son guías reales: si entran quedan como envíos "pendiente"
// fantasma (pasó con ~2.300 filas que hubo que borrar a mano).
describe("devolución consumada (estado de despacho)", () => {
  const returned = (raw: Record<string, string>) =>
    parseAliclikRow({ "NRO. PEDIDO": "AUR5X1", ...raw });

  it("lee RETURNED de 'ÚLTIMO ESTADO DESPACHO' (vocabulario de la API)", () => {
    const row = returned({
      "ÚLTIMO ESTADO DESPACHO": "RETURNED",
      "ESTADO ENTREGA": "CANCELADO",
    });
    expect(row.returned).toBe(true);
    // La GUÍA se cierra como anulado; el `devuelto` del PEDIDO lo pone
    // resolveOrderState leyendo returned_at.
    expect(row.delivery_status).toBe("anulado");
  });

  it("lee DEVUELTO de 'ESTADO DESPACHO' (etiqueta en español)", () => {
    const row = returned({ "ESTADO DESPACHO": "DEVUELTO", "ESTADO ENTREGA": "RECHAZADO" });
    expect(row.returned).toBe(true);
    expect(row.delivery_status).toBe("anulado");
  });

  it("tolera acentos, mayúsculas y espacios", () => {
    expect(returned({ "estado despacho": " devuelto " }).returned).toBe(true);
    expect(returned({ "Último Estado Despacho": "returned" }).returned).toBe(true);
  });

  // El motivo de la devolución vive en ESTADO ENTREGA y varía; ninguno de esos
  // valores debe cambiar el desenlace.
  it.each(["CANCELADO", "NO CONTESTA", "RECHAZADO", "POR ENTREGAR"])(
    "devuelve con ESTADO ENTREGA=%s (el motivo no cambia el desenlace)",
    (entrega) => {
      const row = returned({ "ÚLTIMO ESTADO DESPACHO": "RETURNED", "ESTADO ENTREGA": entrega });
      expect(row.returned).toBe(true);
      expect(row.delivery_status).toBe("anulado");
    },
  );

  it("NO da por devuelto un paquete que todavía vuelve (TO_RETURN / POR DEVOLVER)", () => {
    // Sigue vivo y el equipo lo puede interceptar, así que `returned` es false y
    // la guía no se cierra. Pero tampoco está «por armar»: ya salió del almacén y
    // está físicamente en la calle volviendo, así que su estado es `en_ruta`. En
    // `pendiente` el Master lo dibujaría en Preparación · Por armar, que es
    // justamente lo que este cambio corrige.
    for (const value of ["TO_RETURN", "POR DEVOLVER"]) {
      const row = returned({ "ÚLTIMO ESTADO DESPACHO": value, "ESTADO ENTREGA": "NO CONTESTA" });
      expect(row.returned).toBe(false);
      expect(row.delivery_status).toBe("en_ruta");
    }
  });

  it.each(["PICKED", "VALIDADO", "EN AGENCIA", "-", ""])(
    "no devuelve con despacho=%s",
    (value) => {
      expect(returned({ "ESTADO DESPACHO": value }).returned).toBe(false);
    },
  );

  // La guarda que protege la regla existente: una guía entregada arrastra basura
  // en las columnas de despacho/entrega de la API (PICKED + CANCEL heredado de un
  // intento previo). ENTREGADO debe seguir ganando.
  it("ENTREGADO gana sobre cualquier ruido del despacho", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      "ESTADO ENTREGA": "ENTREGADO",
      "ÚLTIMO ESTADO DESPACHO": "PICKED",
      "ÚLTIMO ESTADO ENTREGA": "CANCEL",
    });
    expect(row.delivery_status).toBe("entregado");
    expect(row.returned).toBe(false);
  });

  it("una entrega nunca se marca como devuelta", () => {
    const row = parseAliclikRow({
      "NRO. PEDIDO": "AUR5X1",
      "ESTADO ENTREGA": "ENTREGADO",
      "ESTADO DESPACHO": "DEVUELTO",
    });
    expect(row.delivery_status).toBe("entregado");
    expect(row.returned).toBe(false);
  });

  // Sin fecha de despacho, `resolveOrderState` no da por probada la devolución
  // (returnProven exige despacho) y el pedido no llega nunca a `devuelto`.
  it("lee FECHA DESPACHO — la cabecera real, sin 'de'", () => {
    const row = returned({
      "ESTADO DESPACHO": "DEVUELTO",
      "FECHA DESPACHO": "15/06/2026",
    });
    expect(row.dispatch_date).toBe("2026-06-15");
  });

  it("acepta también la variante 'FECHA DE DESPACHO'", () => {
    expect(returned({ "FECHA DE DESPACHO": "01/07/2026" }).dispatch_date).toBe("2026-07-01");
  });

  it("sin fecha de despacho legible deja dispatch_date en null", () => {
    expect(returned({ "FECHA DESPACHO": "" }).dispatch_date).toBeNull();
    expect(returned({ "FECHA DESPACHO": "no-es-fecha" }).dispatch_date).toBeNull();
    expect(returned({}).dispatch_date).toBeNull();
  });

  it("sin columnas de despacho no devuelve nada", () => {
    expect(returned({ "ESTADO ENTREGA": "POR ENTREGAR" }).returned).toBe(false);
  });
});

describe("filas IMPORTADO (ESTADO LLAMADA)", () => {
  it("descarta la fila marcada IMPORTADO y conserva las demás", () => {
    const rows = parseAliclikReport([
      { "Guia Aliclik": "AUR5X1", "ESTADO LLAMADA": "CONFIRMADO" },
      { "Guia Aliclik": "AUR5X2", "ESTADO LLAMADA": "IMPORTADO" },
      { "Guia Aliclik": "AUR5X3", "ESTADO LLAMADA": "" },
    ]);
    expect(rows.map((r) => r.guide_code)).toEqual(["AUR5X1", "AUR5X3"]);
  });

  it("reconoce el valor sin importar mayúsculas, espacios o acentos", () => {
    expect(isImportadoRow({ "ESTADO LLAMADA": "IMPORTADO" })).toBe(true);
    expect(isImportadoRow({ "Estado Llamada": " importado " })).toBe(true);
    expect(isImportadoRow({ "estado de llamada": "Importado" })).toBe(true);
  });

  it("no descarta otros estados de llamada", () => {
    expect(isImportadoRow({ "ESTADO LLAMADA": "CONFIRMADO" })).toBe(false);
    expect(isImportadoRow({ "ESTADO LLAMADA": "NO CONTESTA" })).toBe(false);
    expect(isImportadoRow({ "ESTADO LLAMADA": "" })).toBe(false);
    expect(isImportadoRow({})).toBe(false);
  });

  it("no confunde la columna con el 'ESTADO' suelto de la entrega", () => {
    // Un reporte entregado cuyo ESTADO dice "entregado" NO debe descartarse, y
    // una guía IMPORTADO no debe leerse como estado de entrega.
    expect(isImportadoRow({ Estado: "Entregado" })).toBe(false);
    expect(isImportadoRow({ Estado: "Importado" })).toBe(false);
    const rows = parseAliclikReport([{ "Guia Aliclik": "AUR5X9", Estado: "Entregado" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery_status).toBe("entregado");
  });
});
