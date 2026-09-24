// Identidad humana de una salida física del MOM.
// El QR usa un token opaco de base de datos; este código es la etiqueta legible
// que permite al equipo hablar de "la salida 2" sin confundirla con el pedido.

export const MAX_OUTPUTS_PER_ORDER = 5;

/**
 * Courier de una salida que todavía no se decidió (MOM §4).
 *
 * La identidad de una salida es `pedido + consecutivo` (`KP123-S02`) y el QR es
 * un token opaco: el courier es un **metadato visible**, no parte de la
 * identidad. Por eso el almacén puede armar y rotular el paquete antes de saber
 * con quién sale, y el courier se fija cuando la caja entra a la ruta de un
 * courier concreto — que es cuando la decisión ocurre de verdad.
 */
export const COURIER_TBD = "por_definir";

export function isCourierTbd(courier: string | null | undefined): boolean {
  return (courier ?? "").trim().toLowerCase() === COURIER_TBD;
}

/** `created_via` de las salidas que nacen en el Master sin API de courier. */
export const MANUAL_ROUTE_CREATED_VIA = "mom_manual_route";

/**
 * ¿Se puede anular esta salida de ruta manual desde el Master?
 *
 * Existe porque el sistema sabía decir "anúlala antes de crear otra" sin tener
 * dónde anularla: el botón de «Salidas y guías» solo se pintaba para Shalom, y
 * ningún camino movía a `anulado` una salida de `mom_manual_route`. Una salida
 * creada por error —o con el courier equivocado— dejaba al pedido sin poder
 * emitir ninguna otra guía, y el pedido tampoco podía finalizarse, porque el
 * cierre exige que no queden salidas activas. Callejón sin salida por ambos
 * lados.
 *
 * ANULAR NO ES BORRAR. La fila se queda con su historial y su consecutivo: el
 * rótulo pudo haberse impreso y estar pegado a una caja, y ese número tiene que
 * seguir resolviendo —diciendo "anulada"— en vez de dar 404. El consecutivo
 * tampoco se reutiliza (§4).
 *
 * Solo alcanza a las salidas que Kapta creó como ruta manual. Aliclik, Shalom y
 * Tanders tienen su propia anulación, que además avisa al courier por API:
 * marcarlas acá dejaría la guía viva del otro lado y muerta en el panel.
 */
export function manualOutputIsCancelable(output: {
  courier: string;
  created_via?: string | null;
  delivery_status: string;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
}): boolean {
  if (output.created_via !== MANUAL_ROUTE_CREATED_VIA) return false;
  // `pendiente` es el único estado que sigue siendo "esto todavía no pasó". Con
  // la salida en ruta, entregada o devuelta hay hechos físicos detrás y el
  // camino correcto es el retorno, no el borrón.
  if (output.delivery_status !== "pendiente") return false;
  // Mientras la caja siga en casa, anular corrige un registro. Una vez
  // transferida al motorizado hay un paquete en la calle: eso se cierra
  // recibiendo su retorno.
  if ((output.custody_state ?? "empresa") !== "empresa") return false;
  return !output.custody_transferred_at;
}

/** `created_via` de la guía Swayp emitida desde un pedido, sin madre de Aliclik. */
export const FENIX_DIRECT_CREATED_VIA = "fenix_directo";

/**
 * ¿Se puede anular esta guía de Swayp desde el Master?
 *
 * EXISTE POR UN AGUJERO MEDIDO, y el pedido #AUR176830 lo enseña entero. Su
 * salida nació «por definir», se le escribió encima la guía de Swayp, y cuando
 * hubo que cambiar de courier no había dónde deshacerlo: el Master solo pinta
 * «Anular» para Shalom y «Anular salida» para la ruta manual, y rellenar la
 * salida le cambia la vía, así que las dos desaparecen. El único botón alcanzable
 * era el de Envíos, cuya disposición «cancela» significa OTRA COSA —la clienta
 * canceló la venta— y por tanto cierra el pedido. Se registró eso, el pedido cayó
 * a `anulado` por ser su única salida real, y Tanders se negó a emitir la guía
 * siguiente. La misma forma de #KP127639, llegando por una tercera puerta.
 *
 * El MOM ya lo daba por resuelto: «esa guía ya existe del otro lado y se anula
 * desde su propio botón» (§4). Para Swayp ese botón no existía. Esto es el
 * predicado que lo pinta; el servidor revalida lo mismo.
 *
 * SOLO LAS DIRECTAS. Una guía Swayp hija de una reprogramación
 * (`spinOffFenixGuide`) no entra: esa nace de un intento fallido de Aliclik y su
 * cancelación es un hecho de reproprovincia (§11), no un cambio de courier.
 *
 * Que haya que avisar a Swayp o no lo decide el servidor mirando `swayp_guide`:
 * una guía que Swayp nunca emitió es un registro nuestro y se corrige sola; una
 * que sí, se cancela allá PRIMERO y solo entonces acá, porque marcarla anulada de
 * este lado dejándola viva del otro es la peor de las dos mentiras.
 */
export function fenixOutputIsCancelable(output: {
  courier: string;
  created_via?: string | null;
  delivery_status: string;
  dispatched_at?: string | null;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
}): boolean {
  if (output.courier !== "fenix") return false;
  if (output.created_via !== FENIX_DIRECT_CREATED_VIA) return false;
  // Una guía Swayp directa nace `en_ruta` con su fecha de despacho, así que
  // `pendiente` no alcanza como filtro —dejaría fuera justo el caso normal—.
  // Lo que sí cierra la puerta es que la caja ya se haya movido.
  if (!["pendiente", "en_ruta"].includes(output.delivery_status)) return false;
  if (output.dispatched_at) return false;
  if ((output.custody_state ?? "empresa") !== "empresa") return false;
  return !output.custody_transferred_at;
}

/**
 * ¿Esta salida se puede RELLENAR con la guía de un courier?
 *
 * Una salida «por definir» es una caja armada y rotulada esperando a saber quién
 * la lleva — el MOM dice que el courier «se fijará al entrar a una ruta» y que es
 * un metadato visible, no parte de la identidad ni del QR. Cuando se crea la guía
 * en Tanders, Aliclik o Shalom, lo que ocurre físicamente es exactamente eso: se
 * decidió el courier de ESA caja. Así que la guía se escribe encima de la salida
 * que ya existe en vez de abrir una segunda.
 *
 * POR QUÉ IMPORTA, y no es cosmético:
 *
 *   - UNA CAJA, UNA SALIDA. Dos filas para un solo paquete es la duplicidad que
 *     el MOM persigue en todo el documento.
 *   - EL TOPE DE CINCO SALIDAS ES UN PRESUPUESTO REAL (§4). Gastar una en «me
 *     equivoqué de courier» consume un reenvío que después hace falta de verdad.
 *   - CONSERVA EL CONSECUTIVO, EL QR Y EL ESCANEO. El rótulo interno dice «Por
 *     definir» y el equipo le pega encima el del courier, así que sigue siendo
 *     válido; y el `package_ready` de la caja no se pierde.
 *   - Y evita el rodeo que rompía pedidos: sin esto había que ANULAR la salida
 *     para poder emitir la guía, y anularla arrastraba al pedido (#KP127639).
 *
 * Mismas condiciones que para anularla, más el courier sin decidir: si ya tiene
 * courier, rellenarla estaría pisando una decisión anterior, y eso es un cambio
 * de courier — que es otra cosa y tiene su propio camino.
 */
export function isFillableRouteOutput(output: {
  courier: string;
  created_via?: string | null;
  delivery_status: string;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
}): boolean {
  if (!isCourierTbd(output.courier)) return false;
  return manualOutputIsCancelable(output);
}

/**
 * De varias candidatas, la que se rellena.
 *
 * El MOM ya advierte que puede haber más de una salida activa y que Kapta debe
 * alertar; mientras tanto, aquí se elige la de consecutivo MÁS ALTO: es la última
 * que se creó, y por tanto la caja que el almacén tiene delante. Elegir la más
 * vieja rellenaría una salida que quizá se dio por perdida.
 */
export function pickFillableRouteOutput<
  T extends {
    courier: string;
    created_via?: string | null;
    delivery_status: string;
    custody_state?: string | null;
    custody_transferred_at?: string | null;
    output_number?: number | null;
  },
>(outputs: readonly T[]): T | null {
  let best: T | null = null;
  for (const o of outputs) {
    if (!isFillableRouteOutput(o)) continue;
    if (!best || (o.output_number ?? 0) > (best.output_number ?? 0)) best = o;
  }
  return best;
}

/** El evento que deja el botón «Anular salida». Es la ÚNICA prueba de que una
 *  salida se anuló corrigiendo un registro y no por cualquier otro camino. */
export const ROUTE_OUTPUT_CANCELLED = "route_output_cancelled";

/**
 * ¿Esta salida anulada es una CORRECCIÓN DE REGISTRO, y no un hecho logístico?
 *
 * El MOM lo dice con todas las letras (§4): anular una salida de ruta manual es
 * «la corrección de un registro —la salida creada por error o con el courier
 * equivocado—, no un hecho logístico», y «tras anularla, el pedido vuelve a
 * poder crear guía de agencia y a finalizarse».
 *
 * Hacía falta preguntarlo porque `resolveOrderState` cerraba el pedido como
 * `anulado` en cuanto TODAS sus guías estaban anuladas, sin mirar por qué. Esa
 * regla se escribió para el Excel del courier —guías que el courier reporta
 * canceladas tras agotar intentos— y con una sola salida se cumplía por vacío:
 * corregir el courier anulaba la venta, y encima bloqueaba la guía nueva que
 * motivaba la corrección. Pasó con #KP127639.
 *
 * EXIGE LA PRUEBA, NO LA DEDUCE, y esto no es escrúpulo: deducirla de la FORMA
 * de la salida (ruta manual + nunca despachada + nunca transferida) capturaba
 * 368 pedidos en producción, de los que solo 2 se habían anulado por este
 * botón. Los otros 366 —336 ya finalizados, S/ 56.216— llegan a esa misma forma
 * por otro camino: la mesa de cierre exige que no queden salidas activas, así
 * que finalizar un pedido deja su salida manual anulada y sin despachar. Con el
 * predicado deducido, arreglar el bug habría REABIERTO 336 expedientes cerrados.
 *
 * Por eso la condición es el evento `route_output_cancelled` que escribe la
 * acción, y que nombra la salida. El resto son guardas baratas sobre lo que esa
 * acción ya exigió al anularla: si la caja llegó a salir después, algo no cuadra
 * y vale más no tocar el estado.
 */
export function cancelledAsRecordCorrection(
  guide: {
    id: string;
    delivery_status: string;
    dispatched_at?: string | null;
    custody_transferred_at?: string | null;
  },
  /** Ids de salidas con evento `route_output_cancelled`. */
  correctedShipmentIds: ReadonlySet<string>,
): boolean {
  if (guide.delivery_status !== "anulado") return false;
  if (!correctedShipmentIds.has(guide.id)) return false;
  if (guide.dispatched_at) return false;
  return !guide.custody_transferred_at;
}

/** Las salidas que se anularon por el botón, sacadas de los eventos del pedido. */
export function correctedShipmentIds(
  events: readonly { kind: string; shipment_id?: string | null }[],
): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === ROUTE_OUTPUT_CANCELLED && e.shipment_id) out.add(e.shipment_id);
  }
  return out;
}

/** El evento que deja `writeCourierGuide` al escribir sobre una salida que ya
 *  existía. Es la ÚNICA prueba de que esa fila fue antes una «por definir». */
export const ROUTE_OUTPUT_FILLED = "route_output_filled";

/** Las salidas que nacieron «por definir» y recibieron después la guía. */
export function filledShipmentIds(
  events: readonly { kind: string; shipment_id?: string | null }[],
): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === ROUTE_OUTPUT_FILLED && e.shipment_id) out.add(e.shipment_id);
  }
  return out;
}

/**
 * El código de guía interno de una salida sin courier: `MOM-KP123-POR_DEFINIR-7F1EA6F4`.
 *
 * Se calcula, no se guarda, y eso es lo que permite DESHACER un relleno: cuando
 * la guía del courier se escribió encima, el código interno original se perdió
 * —lo pisó el número del courier—, pero es una función pura del pedido y del id
 * de la fila, así que se reconstruye idéntico. Lo comparten quien crea la salida
 * y quien la devuelve a «por definir», para que no puedan divergir.
 */
export function manualRouteGuideCode(
  orderName: string | null | undefined,
  shipmentId: string,
  courier: string = COURIER_TBD,
): string {
  const base = normalizeOrderCode(orderName) || shipmentId.slice(0, 8).toUpperCase();
  return `MOM-${base}-${courier.toUpperCase()}-${shipmentId.slice(0, 8).toUpperCase()}`;
}

/**
 * Devolver una salida rellenada a «por definir».
 *
 * Anular la guía de un courier sobre una salida RELLENADA no puede significar lo
 * mismo que anular una salida cualquiera: la caja no desaparece: sigue armada,
 * rotulada y en el almacén, y lo único que dejó de ser cierto es quién la lleva.
 * Con una sola salida, marcarla `anulado` cerraba la venta entera —el pedido
 * pasa a `anulado` cuando todas sus guías lo están— y encima bloqueaba la guía
 * nueva que motivaba la corrección. Es la misma forma de #KP127639 llegando por
 * la puerta del courier en vez de por la del botón «Anular salida».
 *
 * Así que se deshace el relleno en lugar de anular: vuelve a `por definir`,
 * `pendiente`, con su código interno reconstruido. El consecutivo, el QR y el
 * avance de preparación ni se tocan — nunca dejaron de ser de esta caja.
 *
 * Los campos del courier los limpia quien llama: son suyos y solo él los conoce.
 */
export function restoredRouteOutputPatch(
  orderName: string | null | undefined,
  shipmentId: string,
): Record<string, unknown> {
  return {
    courier: COURIER_TBD,
    created_via: MANUAL_ROUTE_CREATED_VIA,
    guide_code: manualRouteGuideCode(orderName, shipmentId),
    delivery_status: "pendiente",
    status_category: "pending",
    pickup_state: null,
    agency_branch: null,
  };
}

/** `#KP123` → `KP123`; conserva letras/números/guiones y elimina ruido. */
export function normalizeOrderCode(orderName: string | null | undefined): string {
  return (orderName ?? "")
    .trim()
    .replace(/^#+/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "")
    .replace(/_+/g, "-");
}

/** Código estable de salida, sin courier: `KP123-S02`. */
export function buildOutputCode(
  orderName: string | null | undefined,
  outputNumber: number | null | undefined,
): string {
  const order = normalizeOrderCode(orderName);
  const number = Math.trunc(outputNumber ?? 0);
  if (!order || number < 1) return "";
  return `${order}-S${String(number).padStart(2, "0")}`;
}

/**
 * Etiqueta operativa: `KP123-S02-SWAYP`. No es el payload del QR.
 *
 * Una salida sin courier decidido se queda en `KP123-S02`: añadir un sufijo
 * "POR-DEFINIR" ensuciaría el código con algo que además va a cambiar.
 */
export function outputDisplayCode(
  outputCode: string | null | undefined,
  courier: string | null | undefined,
): string {
  const base = (outputCode ?? "").trim().toUpperCase();
  if (!base) return "";
  if (isCourierTbd(courier)) return base;
  const courierCode = (courier ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return courierCode ? `${base}-${courierCode}` : base;
}

/** La regla es por pedido y operación, no solo por nombre del courier. */
export function canRepeatCourier(input: {
  courier: string;
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida";
  priorOutputsWithCourier: number;
  totalOutputs: number;
}): { allowed: boolean; reason: "ok" | "max_outputs" | "courier_already_used" } {
  if (input.totalOutputs >= MAX_OUTPUTS_PER_ORDER) {
    return { allowed: false, reason: "max_outputs" };
  }
  if (input.priorOutputsWithCourier <= 0) return { allowed: true, reason: "ok" };

  const courier = input.courier.trim().toLowerCase();
  if (courier === "axel" || courier === "axel courier" || courier === "propio" || courier === "motorizado propio") {
    return { allowed: true, reason: "ok" };
  }
  // Swayp se puede repetir en Reproprovincia, pero solo una vez en Lima.
  if ((courier === "swayp" || courier === "fenix") && input.operation === "provincia_cod") {
    return { allowed: true, reason: "ok" };
  }
  const oneUse = new Set(["swayp", "fenix", "urpi", "tanders"]);
  if (oneUse.has(courier)) return { allowed: false, reason: "courier_already_used" };

  // Aliclik y cualquier courier nuevo permanecen habilitados hasta que exista
  // una política acordada; Fase 1 no debe inventar un bloqueo comercial.
  return { allowed: true, reason: "ok" };
}

/**
 * El nombre de un courier tal como lo dice la operación.
 *
 * EXISTE POR UN AVISO QUE MANDABA A OTRO SITIO. La guía Swayp directa decía
 * «ya tiene una guía activa: MOM-KP134416-PROPIO-… (Aliclik · pendiente)», y la
 * salida era de Grupo GF Courier. El código elegía entre dos nombres —`fenix` →
 * Swayp, todo lo demás → Aliclik— así que cualquier otro courier se anunciaba
 * como Aliclik, y quien lo leía iba a buscar al panel de Aliclik una guía que
 * no estaba ahí.
 *
 * Lo desconocido se devuelve tal cual: un id crudo es feo pero no miente.
 */
export function nombreDeCourier(courier: string | null | undefined): string {
  const key = (courier ?? "").trim().toLowerCase();
  const nombres: Record<string, string> = {
    aliclik: "Aliclik",
    fenix: "Swayp",
    swayp: "Swayp",
    tanders: "Tanders",
    shalom: "Shalom",
    olva: "Olva",
    urpi: "Urpi",
    axel: "Axel Courier",
    "axel courier": "Axel Courier",
    propio: "Grupo GF Courier",
    "motorizado propio": "Grupo GF Courier",
    [COURIER_TBD]: "Sin courier definido",
  };
  return nombres[key] ?? (courier?.trim() || "courier desconocido");
}

/** Lo mínimo de una salida existente para decidir si estorba a otra. */
export interface SalidaExistente {
  courier: string;
  delivery_status: string;
  guide_code?: string | null;
  output_code?: string | null;
  created_via?: string | null;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
}

const ESTADOS_VIVOS = new Set(["pendiente", "en_ruta", "por_preparar"]);

/**
 * Las salidas que siguen vivas y que la guía nueva NO va a aprovechar.
 *
 * Una «por definir» todavía en casa no cuenta: la guía se le escribe encima.
 * Una devuelta tampoco: ya volvió.
 */
export function salidasQueEstorban<T extends SalidaExistente>(outputs: readonly T[]): T[] {
  return outputs.filter(
    (o) =>
      ESTADOS_VIVOS.has(o.delivery_status) &&
      o.custody_state !== "devuelto" &&
      !isFillableRouteOutput({
        courier: o.courier,
        created_via: o.created_via ?? null,
        delivery_status: o.delivery_status,
        custody_state: o.custody_state ?? null,
        custody_transferred_at: o.custody_transferred_at ?? null,
      }),
  );
}

function describirSalida(o: SalidaExistente): string {
  const codigo = o.output_code?.trim() || o.guide_code?.trim() || "sin código";
  return `${codigo} (${nombreDeCourier(o.courier)}, ${o.delivery_status})`;
}

function mismoCourier(a: string, b: string): boolean {
  const canon = (c: string) => {
    const k = c.trim().toLowerCase();
    if (k === "swayp") return "fenix";
    if (k === "axel courier") return "axel";
    if (k === "motorizado propio") return "propio";
    return k;
  };
  return canon(a) === canon(b);
}

export type PuertaDeSalidaAdicional =
  | { ok: true; estorban: SalidaExistente[]; motivo: string | null }
  | { ok: false; error: string; estorban: SalidaExistente[]; pideMotivo: boolean };

/**
 * ¿Se puede emitir una guía de este courier con otra salida todavía viva?
 *
 * EN LIMA, SÍ. Es el principio 7 del MOM —«un pedido puede tener varias
 * salidas físicas simultáneas»— y §9 lo concreta: «no es obligatorio esperar la
 * devolución anterior para crear otra salida». Si Grupo GF no entregó hoy, no
 * hay que esperar su reporte ni la liquidación de su ruta para mandarlo mañana
 * por Tanders o por Swayp.
 *
 * La mesa de ruta manual (Axel, Urpi, Grupo GF) ya lo cumplía: con otra salida
 * activa pide el motivo y sigue. Tanders y Swayp directa, en cambio, se negaban
 * en seco con «el pedido ya tiene una guía activa, anúlala» — y anularla no es
 * posible cuando la caja ya está en la calle. Eran callejones sin salida para
 * #KP134960 y #KP134416 (24-09-2026).
 *
 * Lo que NO se afloja, porque también es del MOM:
 *   · la salida adicional exige MOTIVO escrito (§23, «justificación auditada»);
 *   · el máximo de cinco salidas por pedido (§4);
 *   · la repetición por courier (§9.3): Swayp, Urpi y Tanders una sola vez por
 *     pedido en Lima. Es `canRepeatCourier`, la misma que usa la mesa manual.
 *
 * FUERA DE LIMA NO CAMBIA NADA. Reproprovincia sigue exigiendo que no haya otra
 * salida viva antes de una Swayp directa (Fase 3: «valida nuevamente … salidas
 * activas»); solo que ahora el aviso nombra bien al courier.
 */
export function puertaDeSalidaAdicional(input: {
  /** Courier de la guía que se quiere emitir: `tanders`, `fenix`… */
  courier: string;
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida";
  /** TODAS las salidas del pedido, vivas o no: la repetición cuenta todas. */
  outputs: readonly SalidaExistente[];
  motivo: string | null | undefined;
}): PuertaDeSalidaAdicional {
  const estorban = salidasQueEstorban(input.outputs);
  const motivo = input.motivo?.trim() || null;
  if (!estorban.length) return { ok: true, estorban, motivo: null };

  const lista = estorban.map(describirSalida).join(", ");
  const nombre = nombreDeCourier(input.courier);

  if (input.operation !== "lima") {
    return {
      ok: false,
      pideMotivo: false,
      estorban,
      error:
        `Este pedido ya tiene una salida activa: ${lista}. ` +
        "Fuera de Lima hay que gestionarla o anularla antes de emitir otra guía.",
    };
  }

  const repeticion = canRepeatCourier({
    courier: input.courier,
    operation: input.operation,
    priorOutputsWithCourier: input.outputs.filter((o) => mismoCourier(o.courier, input.courier)).length,
    totalOutputs: input.outputs.length,
  });
  if (!repeticion.allowed) {
    return {
      ok: false,
      pideMotivo: false,
      estorban,
      error:
        repeticion.reason === "max_outputs"
          ? `El pedido ya alcanzó el máximo de ${MAX_OUTPUTS_PER_ORDER} salidas.`
          : `${nombre} ya se usó en este pedido y en Lima solo se permite una vez.`,
    };
  }

  if (!motivo) {
    return {
      ok: false,
      pideMotivo: true,
      estorban,
      error:
        `Este pedido todavía tiene ${estorban.length === 1 ? "una salida activa" : `${estorban.length} salidas activas`}: ${lista}. ` +
        `En Lima puedes sacarlo por ${nombre} sin esperar su reporte: escribe el motivo de la salida adicional.`,
    };
  }

  return { ok: true, estorban, motivo };
}
