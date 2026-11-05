// Manifiesto de devolución (fase 1, Grupo GF) y el pedido anulado en la tienda
// que vuelve a inventario (decisiones del owner, 04-11-2026; 0307): que lo que
// el MOM fija en el glosario, §9.4, §13, §15, §29.7, §29.13 y §30.10 sea lo que
// hacen el código y la migración. Las reglas, probadas en
// test/return-manifest.test.ts, test/gf-office-receipts.test.ts y
// scripts/sql/return_manifests_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ARRIVED_WITHOUT_REPORT_CHAIN_REASON, limaRetryChain, stopChainReason } from "@/lib/lima-retry-chain";
import {
  classifyManifestScan,
  ARRIVED_WITHOUT_REPORT_NOTE,
  ARRIVED_WITHOUT_REPORT_REASON,
  DEFAULT_RETURN_CADENCE_DAYS,
  REPROGRAMADO_KEEP_DAYS,
  RETURN_MANIFEST_PERMISSION,
  RIDER_RETURN_CADENCE_DAYS,
  STALE_OPEN_MANIFEST_DAYS,
  URPI_RETURN_CADENCE_DAYS,
  buildReturnManifestActa,
  bucketReturnManifest,
  drawerLineLabel,
  expectedBucket,
  laterPhysicalReceipt,
  notebookOfficeConflictMessage,
  returnCadenceFor,
  riderReturnCadenceDays,
  type ReturnManifestLine,
} from "@/lib/return-manifest";
import { storeCancelledReceivedMessage, storeCancelledReceivedNotice } from "@/lib/gf-office-receipt";
import { officeReturnOutcome } from "@/lib/gf-replaced-output";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const MOM_FLAT = flat(MOM);
const SQL = read("db/migrations/0307_return_manifests.sql");

/** El texto de una sección del MOM, desde su título hasta el siguiente del mismo nivel o superior. */
function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

/** Desde `lead` hasta `end` (incluido), aplanado. */
function block(lead: string, end: string): string {
  const start = MOM.indexOf(lead);
  expect(start, lead).toBeGreaterThan(-1);
  const stop = MOM.indexOf(end, start);
  expect(stop, end).toBeGreaterThan(start);
  return flat(MOM.slice(start, stop + end.length));
}

const RECEIVED_OTHER_BOX: ReturnManifestLine = {
  id: "l1", shipmentId: "s1", storeId: "st", orderId: "o1", orderName: "#KP1", outputCode: "KP1-S01", scannedCode: "KP1-S01",
  sourceRiderName: "Roy", sourceRouteDate: "2026-11-03", reportedStatus: "no_entregado", reportedReason: "no_contesta",
  expected: false, outcome: "received", flags: ["otra_caja"], receiptOutcome: "por_asignar", message: null, note: null,
  scanCount: 1, scannedAt: "2026-11-04T15:00:00.000Z", removedAt: null, removalReason: null,
};

/** Un párrafo del MOM que empieza con `lead`, hasta la línea en blanco siguiente. */
function paragraph(lead: string): string {
  const start = MOM.indexOf(lead);
  expect(start, lead).toBeGreaterThan(-1);
  const end = MOM.indexOf("\n\n", start);
  return flat(MOM.slice(start, end === -1 ? undefined : end));
}

const MANIFEST = "#### Manifiesto de devolución (fase 1, Grupo GF; decisiones del owner, 04-11-2026)";

describe("glosario", () => {
  it("define el manifiesto de devolución, distinto del de salida", () => {
    const glossary = section("### Manifiesto de devolución");
    expect(glossary).toContain("Registro de lo que un motorizado trae de vuelta a la oficina de una vez");
    expect(glossary).toContain("no transfiere custodia por sí mismo; cada caja se recibe con la recepción de siempre («Recibir en oficina», §29.13).");
    expect(glossary).toContain("No es un estado del pedido ni una subetapa. Fase 1: Grupo GF; Urpi en la fase 2.");
    // Va después del manifiesto de salida.
    expect(MOM.indexOf("### Manifiesto de devolución")).toBeGreaterThan(MOM.indexOf("### Manifiesto\n"));
  });
});

describe("§9.4 el manifiesto de devolución", () => {
  const s = section(MANIFEST);

  it("está dentro de §9.4, antes de §9.5", () => {
    const at = MOM.indexOf(MANIFEST);
    expect(at).toBeGreaterThan(MOM.indexOf("### 9.4 Reportes, pagos y devoluciones físicas de Lima"));
    expect(at).toBeLessThan(MOM.indexOf("### 9.5 Reprogramación en Lima"));
  });

  it("cita el pedido del owner y no crea estados ni sube la versión del resolver", () => {
    expect(s).toContain("«si llegan las devoluciones de alexis o de urpi que llegan de varios días juntos, se pueda hacer un manifiesto con todo lo que llegó para llevar un registro con lo que reporta alexis»");
    expect(s).toContain("el manifiesto **no cambia estados de pedido por su cuenta** y no agrega estados de pedido, subetapas, veredictos del Master ni tipos de `order_events` o `dispatch_events`.");
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.39");
    expect(s).toContain("`MOM_RESOLUTION_VERSION` no cambia (`mom-v1.38`).");
  });

  it("el permiso es el de Almacén, el mismo que el código", () => {
    expect(RETURN_MANIFEST_PERMISSION).toBe("warehouse.prepare");
    expect(s).toContain("**Quién (owner: «si, mismo almacen»).** El permiso de Almacén, **`warehouse.prepare`**, en la organización del manifiesto: abrir, escanear, anotar, cerrar, anular y descargar el acta.");
    expect(s).toContain("lo esperado de otras tiendas solo se cuenta, y una salida de otra tienda no se encuentra ni por su número de pedido.");
  });

  it("uno abierto por courier y motorizado; el plazo se congela al abrir; aviso de abierto viejo", () => {
    expect(s).toContain("Uno abierto por courier y motorizado —no por día: una llegada cubre varios días—; abrirlo otra vez vuelve al que ya está abierto.");
    expect(s).toContain("el plazo del motorizado, que se congela al abrir.");
    expect(STALE_OPEN_MANIFEST_DAYS).toBe(1);
    expect(s).toContain("Un manifiesto abierto hace más de un día sale con aviso en la lista.");
    expect(SQL).toContain("create unique index if not exists return_manifests_one_open");
    expect(SQL).toContain("cadence_days integer not null");
  });

  it("los plazos del MOM son los del código", () => {
    expect(s).toContain("| Alexis | 3 días |");
    expect(s).toContain("| Johnny (Yhoni), Roy y Yordani | 1 día |");
    expect(s).toContain("| Duglas | 1 día, mientras no se defina |");
    expect(s).toContain("| Cualquier otro | 1 día (por defecto) |");
    expect(s).toContain("| Urpi (fase 2) | 14 días |");
    expect(riderReturnCadenceDays("Alexis Quispe")).toBe(3);
    for (const name of ["Johnny", "Yhoni Ramos", "Roy", "Yordani"]) expect(riderReturnCadenceDays(name), name).toBe(1);
    expect(riderReturnCadenceDays("Duglas")).toBe(1);
    expect(RIDER_RETURN_CADENCE_DAYS.alexis).toBe(3);
    expect(DEFAULT_RETURN_CADENCE_DAYS).toBe(1);
    expect(riderReturnCadenceDays("Yukio")).toBe(1);
    expect(URPI_RETURN_CADENCE_DAYS).toBe(14);
    expect(returnCadenceFor("urpi", "Cualquiera")).toBe(14);
  });

  it("la edad va del día de ruta de la caja al día de llegada; «Falta» cuando pasa el plazo", () => {
    expect(s).toContain("La edad de una caja es el número de días entre su día de ruta (`route_date`) y el día de llegada del manifiesto, nunca `reported_at`.");
    expect(s).toContain("Lo esperado que no llegó es **«Con el motorizado»** mientras la edad no pase el plazo, y **«Falta»** cuando lo pasa (edad mayor que el plazo).");
    // Alexis, 3 días: el 01/11 llegando el 04/11 sigue con él; el 31/10, falta.
    expect(expectedBucket({ routeDate: "2026-11-01", outcomeReason: "no_contesta", arrivedOn: "2026-11-04", cadenceDays: 3 })).toBe("con_el_motorizado");
    expect(expectedBucket({ routeDate: "2026-10-31", outcomeReason: "no_contesta", arrivedOn: "2026-11-04", cadenceDays: 3 })).toBe("falta");
    // Roy, 1 día.
    expect(expectedBucket({ routeDate: "2026-11-03", outcomeReason: "no_contesta", arrivedOn: "2026-11-04", cadenceDays: 1 })).toBe("con_el_motorizado");
    expect(expectedBucket({ routeDate: "2026-11-02", outcomeReason: "no_contesta", arrivedOn: "2026-11-04", cadenceDays: 1 })).toBe("falta");
    // El cierre de la base usa la misma regla.
    expect(SQL).toContain("where (v_header.arrived_on - e.route_date) > case when e.outcome_reason = 'reprogramado' then 14 else v_header.cadence_days end");
  });

  it("reprogramado: sigue con él hasta 14 días; después, falta (decisión del owner)", () => {
    expect(s).toContain("**Reprogramados (owner: «los reprogramados de más de 14 días se marca como \"falta\"»).**");
    expect(s).toContain("es **«Reprogramado, sigue con él»** hasta 14 días; con más de 14 días es **«Falta»**, sea cual sea el plazo del motorizado.");
    expect(REPROGRAMADO_KEEP_DAYS).toBe(14);
    expect(expectedBucket({ routeDate: "2026-10-21", outcomeReason: "reprogramado", arrivedOn: "2026-11-04", cadenceDays: 1 })).toBe("reprogramado");
    expect(expectedBucket({ routeDate: "2026-10-20", outcomeReason: "reprogramado", arrivedOn: "2026-11-04", cadenceDays: 3 })).toBe("falta");
  });

  it("escanea con el buscador de Devoluciones y nunca por número de pedido con dos salidas", () => {
    expect(s).toContain("El mismo buscador que Devoluciones (QR, código de salida, guía o número de pedido; `lib/dispatch-scan-lookup.ts`) y la misma regla (`gfReturnDecision`, extendida en `classifyManifestScan`).");
    expect(s).toContain("**Nunca por número de pedido si el pedido tiene dos salidas:** pide el QR (§29.13). Un escaneo repetido actualiza su línea; no agrega otra.");
    const actions = read("app/dashboard/pedidos/devoluciones/manifest-actions.ts");
    expect(actions).toContain("findScanCandidatesWith(sb, code)");
    expect(actions).toContain('if (pick.kind === "ambigua") return { ok: false, kind: "error", error: ambiguousScanError(pick.options) };');
    expect(SQL).toContain("scan_count = return_manifest_lines.scan_count + 1");
  });

  it("la tabla del escaneo nombra cada resultado", () => {
    expect(s).toContain("| En una caja de este motorizado, «No entregado» | La recibe en oficina | Recibida y esperada |");
    expect(s).toContain("| En la caja de otro motorizado, «No entregado» | La recibe en oficina | Recibida, «De otra caja»; no cuenta como esperada |");
    expect(s).toContain("| Su parada sigue pendiente y la ruta está en curso | Reporta «No entregado · Llegó a oficina sin reporte» y la recibe (abajo) | Recibida, «Llegó sin reporte»; no cuenta como esperada |");
    expect(s).toContain("| Reportada entregada | No la recibe | Observación «Reportada entregada · incidencia»");
    expect(s).toContain("| Sin caja: ya recibida en oficina, o en la oficina sin haber salido nunca | Nada | Informativa «Ya recibida» |");
    expect(s).toContain("| Sin caja y devuelta de un pedido anulado en la tienda (o venta terminada): ya se recibió y fue a inventario | Nada | Informativa «Ya recibida»: no bloquea el cierre |");
    // El anulado ya a inventario, escaneado otra vez, es informativo (no «no identificada»).
    expect(classifyManifestScan({
      label: "KP1-S01", headerRiderId: "alexis", courier: "propio", box: null, custodyState: "devuelto",
      receivedInOffice: false, replaced: false, saleEnded: true,
    })).toMatchObject({ outcome: "info", flags: ["ya_recibida"] });
    expect(s).toContain("| No se encuentra, es de otro courier, o no está en una caja ni en la oficina | Nada | Observación «No identificada»: pide una nota antes de cerrar |");
    // Las marcas de la base son las de la tabla.
    expect(SQL).toContain("flags <@ array['otra_caja', 'sin_reporte', 'reportada_entregada', 'ya_recibida', 'no_identificada', 'reprogramado']::text[]");
    expect(SQL).toContain("v_box.rider_id is not distinct from v_header.rider_id and not ('sin_reporte' = any(v_flags)),");
  });

  it("la recepción y su línea son una transacción, con la recepción de siempre", () => {
    expect(s).toContain("La recepción y su línea son **una sola transacción** (`return_manifest_receive`: candado de la cabecera, después el del paquete y su caja).");
    expect(SQL).toContain("v_header := return_manifest_lock_open(p_manifest_id, p_actor);");
    expect(SQL).toContain("v_order := gf_return_to_office(p_item_id, p_actor);");
    expect(s).toContain("Un pedido anulado solo en Kapta (vivo en la tienda) vuelve a «por asignar» con su aviso de ANULADO.");
  });

  it("regla 4: llegó a oficina sin reporte, por la vía única de reporte", () => {
    expect(s).toContain("**Llegó a oficina sin reporte (owner: «si recibo el retorno, lo lógico es que no fue entregado»).**");
    expect(s).toContain("Kapta reporta la parada por la vía única de reporte (`writeStopReport`): «No entregado», motivo «Otro», nota «Llegó a oficina sin reporte · Devolución · Alexis · 04/11», reportada por quien escanea, sin cobro ni foto (no estuvo en la puerta). Después la recibe.");
    expect(ARRIVED_WITHOUT_REPORT_NOTE).toBe("Llegó a oficina sin reporte");
    expect(ARRIVED_WITHOUT_REPORT_REASON).toBe("otro");
    const actions = read("app/dashboard/pedidos/devoluciones/manifest-actions.ts");
    expect(actions).toContain("note: `${ARRIVED_WITHOUT_REPORT_NOTE} · ${header.label}`,");
    expect(actions).toContain("paymentMethod: null,");
    expect(actions).toContain("actor: access.userId,");
    expect(s).toContain("Las paradas que pasaron a otra ruta (`notebook_carried_to_route_id`, 0292) no se miran.");
    expect(read("lib/gf-office-receipt.ts")).toContain(".find((candidate) => !candidate.notebook_carried_to_route_id)");
    expect(s).toContain("no se le paga al motorizado (solo la entrega y el rechazo pagan, `stopEarns`, §29.10) y suma un intento en el Master (§9.3).");
    // Fuera de la cadena de reintentos por Aliclik: sigue Repro Lima.
    expect(s).toContain("**No entra a la cadena de reintentos por Aliclik** (§9.5): nadie fue a la puerta");
    expect(stopChainReason(ARRIVED_WITHOUT_REPORT_REASON, `${ARRIVED_WITHOUT_REPORT_NOTE} · Devolución · Alexis · 04/11`)).toBe(ARRIVED_WITHOUT_REPORT_CHAIN_REASON);
    expect(limaRetryChain([{ carrier: "alexis", reason: ARRIVED_WITHOUT_REPORT_CHAIN_REASON, at: new Date().toISOString() }], new Date())).toMatchObject({ state: "fuera" });
    expect(read("lib/repro-lima-program.ts")).toContain("reason: stopChainReason(stop.outcome_reason, stop.note)");
    expect(section("### 9.5 Reprogramación en Lima: «Repro Lima» (fase 1, entregas 1a y 1c)")).toContain(
      "Tampoco la parada que el manifiesto de devolución reportó «No entregado · Otro» porque la caja llegó a la oficina sin reporte (§9.4, 0307): nadie fue a la puerta.",
    );
  });

  it("cerrar pide «Entregó», anota lo que faltó y no cambia pedidos", () => {
    expect(s).toContain("Pide **«Entregó»** —quién trajo las cajas, al menos 3 letras; se propone el nombre del motorizado—");
    expect(s).toContain("**No cambia ningún pedido ni ninguna salida:** lo que faltó sigue «No entregado» a nombre del motorizado");
    expect(SQL).toContain("if length(btrim(coalesce(p_handed_over_by, ''))) < 3 then raise exception 'Escribe quién entregó las cajas (al menos 3 letras).'; end if;");
    expect(SQL).toContain("Hay % caja(s) no identificada(s) sin nota");
    // Cerrado, la cabecera solo suma fotos.
    expect(s).toContain("**Lo cerrado no cambia** (candado de la base, como `gf.withdraw`): solo se le pueden añadir fotos, porque el acta se firma después.");
    expect(SQL).toContain("and new.photo_paths @> old.photo_paths then");
    // «esperados» no cambia al cerrar: el cierre cuenta lo que seguía en plazo.
    expect(s).toContain("**Y es la misma cifra antes y después de cerrar**, en la pantalla y en el acta");
    expect(SQL).toContain("handed_over_by = left(btrim(p_handed_over_by), 120), pending_at_close = v_pending, updated_at = now()");
  });

  it("una observación cita su parada pendiente sin impedir quitarla; lo cerrado espera al cierre en curso", () => {
    expect(s).toContain("la línea suelta el enlace y conserva lo que leyó (reportado «Sin reporte»), también en un manifiesto cerrado.");
    expect(SQL).toContain("stop_id uuid references delivery_stops(id) on delete set null,");
    expect(SQL).toContain("select state, org_id into v_state, v_org from return_manifests where id = new.manifest_id for share;");
  });

  it("lo que aparece después se deriva en vivo; el sello del courier y la toma sin actor no cuentan", () => {
    expect(s).toContain("el cerrado la muestra «apareció el dd/mm». Solo cuenta una recepción posterior hecha por una persona: ni el sello del courier ni una toma del sistema sin actor (la de Urpi, §30.10) prueban que la caja llegó.");
    const after = "2026-11-04T20:00:00.000Z";
    const human = { shipmentId: "s1", kind: "returned_to_office", actor: "u1", source: "dispatch", occurredAt: "2026-11-06T15:00:00.000Z" };
    expect(laterPhysicalReceipt("s1", after, [human])).toEqual(human);
    expect(laterPhysicalReceipt("s1", after, [{ ...human, actor: null }])).toBeNull();
    expect(laterPhysicalReceipt("s1", after, [{ ...human, source: "tanders_api" }])).toBeNull();
  });

  it("descartar y anular con motivo; lo recibido no se descarta", () => {
    expect(s).toContain("Una observación o una informativa se descarta con motivo (al menos 5 letras); lo recibido y lo que faltó no. Un manifiesto se anula con motivo (al menos 5 letras) y solo si no recibió ninguna caja; si recibió, se cierra.");
    expect(SQL).toContain("constraint return_manifest_lines_removable_ck check (removed_at is null or outcome in ('held', 'info'))");
    expect(SQL).toContain("Ya se recibieron cajas en este manifiesto: ciérralo en vez de anularlo.");
  });

  it("el acta en PDF y Excel, foto opcional y sin datos de clientes", () => {
    expect(s).toContain("**El acta (owner: «opcional, pero que se genere hasta un pdf y excel para descargarlo»).** Se descarga en **PDF y en Excel** (`/api/pedidos/devoluciones/manifiestos/[id]/acta?formato=pdf|xlsx`)");
    expect(s).toContain("**Sin nombres, teléfonos ni direcciones de clientes.** La foto del acta firmada (o de la hoja de entrega) es **opcional**");
    const acta = buildReturnManifestActa({
      header: {
        label: "Devolución · Alexis · 04/11", courierLabel: "Grupo GF", riderFirstName: "Alexis", arrivedOn: "2026-11-04",
        handedOverBy: "Alexis", receivedBy: "Almacén", openedAt: "2026-11-04T15:00:00.000Z", closedAt: null, state: "open",
        declaredCount: null, note: null,
      },
      buckets: bucketReturnManifest({ state: "open", expected: [], lines: [], arrivedOn: "2026-11-04", cadenceDays: 3 }),
    });
    expect(acta.signatures).toEqual(["Entregó", "Recibió"]);
    // Cada fila: #pedido, código de salida, día de la caja, lo reportado y el resultado. Nada del cliente.
    const withLine = buildReturnManifestActa({
      header: acta.header,
      buckets: bucketReturnManifest({ state: "open", expected: [], lines: [RECEIVED_OTHER_BOX], arrivedOn: "2026-11-04", cadenceDays: 3 }),
    });
    expect(Object.keys(withLine.rows[0]!).sort()).toEqual(["boxDay", "n", "orderName", "outputCode", "reported", "result"]);
    // La foto: opcional (no la pide el cierre), y se puede subir cerrado pero no anulado.
    expect(SQL).toContain("photo_paths text[] not null default '{}'");
    expect(read("app/api/pedidos/devoluciones/manifiestos/[id]/foto/route.ts")).toContain('if (ctx.header.state === "cancelled")');
  });

  it("el historial de la salida en la ficha", () => {
    expect(s).toContain("el historial de la salida dice «Recibida en Devolución · Alexis · 04/11», «Faltó en …» (con «apareció el dd/mm» si llegó después)");
    expect(drawerLineLabel({ outcome: "received", flags: [], manifestLabel: "Devolución · Alexis · 04/11" })).toBe("Recibida en Devolución · Alexis · 04/11");
    expect(drawerLineLabel({ outcome: "missing", flags: [], manifestLabel: "Devolución · Alexis · 04/11" })).toBe("Faltó en Devolución · Alexis · 04/11");
  });

  it("Urpi es la fase 2, con la decisión del owner", () => {
    expect(s).toContain("**Fase 2 (no está en este cambio).** Urpi: manifiesto con courier Urpi y plazo de 14 días. Decisión del owner (04-11-2026): una salida de Urpi ya programada cuenta como «salió» para poder recibir su devolución, aunque la custodia siga en la empresa.");
    expect(SQL).toContain("if p_courier <> 'propio' then raise exception 'Por ahora el manifiesto de devolución es de Grupo GF.'; end if;");
  });

  it("los plazos también están en la lista de devoluciones físicas y en el barrido inicial", () => {
    expect(section("### 9.4 Reportes, pagos y devoluciones físicas de Lima")).toContain(
      "Alexis 3 días; Johnny (Yhoni), Roy y Yordani 1; Duglas 1 mientras no se defina (owner, 04-11-2026).",
    );
    const sweep = paragraph("- **Barrido inicial.**");
    expect(sweep).toContain("dentro de un **manifiesto de devolución** de ese motorizado (§9.4, desde el 04-11-2026).");
    expect(sweep).toContain("al cerrar el manifiesto queda como **«Falta»** en su línea");
    expect(sweep).not.toContain("fase posterior");
  });
});

describe("el pedido anulado en la tienda que vuelve va a inventario", () => {
  const rule = block(
    "**Un pedido anulado en la tienda que vuelve va a inventario (04-11-2026,",
    "Pruebas: `test/gf-office-receipts.test.ts`, `test/gf-returns-scan.test.ts`,",
  );

  it("§29.13 lo fija para todas las puertas, en la base", () => {
    expect(rule).toContain("Ahora la decisión está en la base, dentro de `gf_return_to_office` (misma firma), así que vale para **todas las puertas**");
    expect(SQL).toContain("create or replace function public.gf_return_to_office(p_item_id uuid, p_actor uuid)");
    expect(SQL).toContain("v_store_cancelled := exists(select 1 from orders where id = v_shipment.order_id and cancelled_at is not null);");
    expect(SQL).toContain("grant execute on function public.gf_return_to_office(uuid, uuid) to service_role;");
  });

  it("lo que escribe es lo que dice el MOM", () => {
    expect(rule).toContain("la salida sale de la caja con el motivo «Pedido anulado en la tienda: recibido en oficina, va a inventario»");
    expect(SQL).toContain("when v_store_cancelled then 'Pedido anulado en la tienda: recibido en oficina, va a inventario (' || v_rider || ')'");
    expect(rule).toContain("queda `devuelto` con `returned_at`, `returned_by` y `returned_source = manual` (conserva `dispatched_at`)");
    expect(SQL).toContain("set custody_state = 'devuelto', returned_at = coalesce(returned_at, now()),");
    expect(rule).toContain("el pedido está anulado en la tienda. Va a inventario —Almacén decide stock o merma—; no vuelve a «por asignar».");
    expect(SQL).toContain("'): el pedido está anulado en la tienda. Va a inventario —Almacén decide stock o merma—; no vuelve a «por asignar».'");
    expect(rule).toContain("(`store_cancelled_return_received`)");
    expect(SQL).toContain("'store_cancelled_return_received'");
    expect(rule).toContain("No pasa por Repro Lima.");
  });

  it("el aviso de cada puerta es el que cita", () => {
    expect(rule).toContain(`«${storeCancelledReceivedMessage("KP1-S01", "Alexis", "2026-11-03")}»`);
    expect(rule).toContain(`«${storeCancelledReceivedNotice(2).replace(/^2/, "N")}»`);
    expect(officeReturnOutcome("devuelto", false, true)).toBe("a_inventario_anulado");
    expect(officeReturnOutcome("devuelto", true, true)).toBe("a_stock_reemplazada");
    expect(officeReturnOutcome("empresa", false, false)).toBe("por_asignar");
  });

  it("Urpi no toma la caja, y lo que no cambia", () => {
    expect(rule).toContain("(`urpi_take_gf_output` responde `anulado_en_tienda`, §30.10)");
    expect(SQL).toContain("and cancelled_at is not null) then return 'anulado_en_tienda'; end if;");
    expect(section("### 30.10 Programaciones mensuales enviadas a Urpi (01/10/2026)")).toContain("si el pedido está anulado en la tienda (`anulado_en_tienda`, 0307");
    expect(rule).toContain("Un pedido reactivado en la tienda (`cancelled_at` nulo) se recibe como siempre. Uno anulado solo en Kapta (`general_status` anulado, vivo en la tienda) vuelve a «por asignar» con el aviso de ANULADO");
    expect(rule).toContain("`MOM_RESOLUTION_VERSION` no cambia (`mom-v1.38`).");
    // La venta histórica de Shopify terminada en Kapta no toca `cancelled_at`: se nombra y queda la pregunta.
    expect(rule).toContain("**venta histórica de Shopify terminada en Kapta** (`legacy_shopify_sale_cancelled`, §38.16)");
    expect(rule).toContain("**Pregunta abierta al owner:** ¿esa venta cuenta como terminada y su caja va a inventario?");
    expect(rule).not.toContain("la tienda no terminó la venta");
    expect(SQL).not.toContain("legacy_shopify_sale_cancelled");
  });

  it("ya no dice que el anulado solo «se separa para el stock»", () => {
    expect(MOM_FLAT).not.toContain("el aviso dice que está anulado y se separa para el stock");
    expect(MOM_FLAT).toContain("Solo la anulación en la tienda termina la venta: un anulado que vuelve se recibe igual —la caja tiene que salir de la del motorizado— y, desde el 04-11-2026, va a inventario (abajo).");
  });

  it("§13, v1.23, Rutas y la tabla de Devoluciones lo dicen", () => {
    expect(section("## 13. Devoluciones, inventario y reclamos")).toContain(
      "**Un pedido anulado en la tienda cuya caja de Grupo GF vuelve va a inventario (owner, 04-11-2026, 0307).**",
    );
    expect(section("## 13. Devoluciones, inventario y reclamos")).toContain("`Por cerrar · Devolución pendiente de inventario` y Yelitza decide stock o merma");
    expect(section("#### En Lima, lo que no se entrega se reprograma (v1.23, 30-09-2026)")).toContain(
      "**La caja de Grupo GF de un pedido anulado en la tienda va a inventario (owner, 04-11-2026, 0307).**",
    );
    expect(MOM_FLAT).toContain("y la de un pedido anulado en la tienda va a inventario (0307, §29.13), contada aparte en el aviso.");
    expect(MOM_FLAT).toContain("y la de un pedido anulado en la tienda, que va a inventario, no programan nada.");
    expect(MOM_FLAT).toContain("el pedido queda por asignar en Grupo GF, en «Por reprogramar Lima». Si el pedido está anulado en la tienda, va a inventario (abajo). |");
  });
});

describe("el cuaderno que llega después (§29.7)", () => {
  it("no pisa la parada: queda la incidencia, con el texto del código", () => {
    const bullet = paragraph("- **La caja que ya llegó a la oficina sin reporte (04-11-2026).**");
    const message = notebookOfficeConflictMessage({ manifestLabel: "…", arrivedOn: "2026-11-04" }).replace("el 04/11", "el dd/mm");
    expect(bullet).toContain(`(«${message}»)`);
    expect(bullet).toContain("al aplicar queda como fila fallida con ese texto —también si se marcó omitir—");
    const apply = read("lib/notebook-apply.ts");
    // La incidencia se mira antes que «omitir».
    expect(apply.indexOf("if (conflict) { fail(r, decision.index, conflict); continue; }")).toBeLessThan(apply.indexOf('if (decision.action === "omitir") { skipped++; continue; }'));
  });
});

describe("§15 responsables", () => {
  it("el manifiesto es de Almacén y la decisión de stock o merma, de Yelitza", () => {
    const s15 = section("## 15. Responsables actuales");
    expect(s15).toContain("| Manifiesto de devolución de Grupo GF: abrir, escanear, cerrar, anular y descargar el acta | Almacén (`warehouse.prepare`) | Quien recibe en Almacén → Devoluciones (§9.4) |");
    expect(s15).toContain("| Stock o merma de una devolución (también la de un pedido anulado en la tienda) | Almacén | Yelitza (§13) |");
  });
});

describe("una línea recibida nunca es esperada si es de otra caja o llegó sin reporte", () => {
  it("los paneles lo separan como dice el MOM", () => {
    const buckets = bucketReturnManifest({ state: "open", expected: [], lines: [RECEIVED_OTHER_BOX], arrivedOn: "2026-11-04", cadenceDays: 3 });
    expect(buckets.llego).toHaveLength(0);
    expect(buckets.sinEsperarse).toHaveLength(1);
  });
});
