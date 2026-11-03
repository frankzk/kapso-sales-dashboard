// El costo logístico de Grupo GF sale de su Tarifario (mom-v1.31; MOM §14,
// §29.8; decisión del dueño del 19-10-2026). Aquí la resolución pura: qué
// tarifa le toca a un pedido de «propio», qué cobra con ella y qué dice el
// aviso cuando no la hay. La lectura y el recálculo, en
// test/gf-tariff-master.test.ts; lo que cita el MOM, en test/gf-tariff-mom.test.ts.

import { describe, expect, it } from "vitest";
import {
  GF_TARIFF_PERMISSION_LABEL,
  GF_TARIFF_SCREEN_HREF,
  GF_TARIFF_SCREEN_LABEL,
  costBlockNeedsTariff,
  costTariffScreen,
  liquidationCostBlock,
} from "@/lib/closure-blocks";
import { computeLogisticsCost, isOwnCourier, type CostTariff, type LogisticsCostInput } from "@/lib/costs";
import { UNREADABLE_GF_TARIFF_BOOK, resolveGfCostTariff, type GfAgreementRow, type GfTariffBook } from "@/lib/gf-tariff";
import type { DistrictTariffRow } from "@/lib/grupo-gf-courier";
import { masterLogisticsCost } from "@/lib/order-master";

const PROVIDER = "gf";
const ORG = "org-1";
const KENKU = "store-kenku";

const rate = (over: Partial<DistrictTariffRow>): DistrictTariffRow => ({
  id: over.id ?? `t-${over.district_key ?? "ate"}`,
  provider_id: PROVIDER,
  agreement_id: null,
  district_key: "ate",
  zone: null,
  delivery_amount: 12,
  rejection_amount: 12,
  includes_igv: true,
  currency: "PEN",
  // Todas las del Tarifario medido el 20-10-2026 rigen desde aquí.
  effective_from: "2026-08-31",
  effective_to: null,
  status: "active",
  ...over,
});

const agreement = (over: Partial<GfAgreementRow> = {}): GfAgreementRow => ({
  id: "ag-kenku",
  provider_id: PROVIDER,
  store_id: KENKU,
  status: "active",
  effective_from: "2026-08-01",
  effective_to: null,
  ...over,
});

const book = (tariffs: DistrictTariffRow[], agreements: GfAgreementRow[] = []): GfTariffBook => ({
  providerByOrg: new Map([[ORG, PROVIDER]]),
  agreements,
  tariffs,
});

const lookup = (district: string | null, day = "2026-10-02", storeId = KENKU) => ({ orgId: ORG, storeId, district, day });

describe("resolveGfCostTariff — la tarifa del Tarifario que le toca a un pedido de Grupo GF", () => {
  it("general: el importe del distrito vigente ese día", () => {
    expect(resolveGfCostTariff(book([rate({ delivery_amount: 12 })]), lookup("Ate"))).toEqual({
      kind: "found",
      amount: 12,
      tariffId: "t-ate",
      source: "general",
      districtKey: "ate",
    });
  });

  it("el acuerdo de la tienda gana a la general", () => {
    const tariffs = [rate({ id: "gen", delivery_amount: 12 }), rate({ id: "kenku", agreement_id: "ag-kenku", delivery_amount: 10 })];
    const found = resolveGfCostTariff(book(tariffs, [agreement()]), lookup("Ate"));
    expect(found).toMatchObject({ kind: "found", amount: 10, tariffId: "kenku", source: "agreement" });
  });

  it("el acuerdo de otra tienda, uno inactivo o uno que no regía ese día no participan: rige la general", () => {
    const tariffs = [rate({ id: "gen", delivery_amount: 12 }), rate({ id: "kenku", agreement_id: "ag-kenku", delivery_amount: 10 })];
    const general = { kind: "found", amount: 12, source: "general" };
    expect(resolveGfCostTariff(book(tariffs, [agreement()]), lookup("Ate", "2026-10-02", "store-aurela"))).toMatchObject(general);
    expect(resolveGfCostTariff(book(tariffs, [agreement({ status: "suspended" })]), lookup("Ate"))).toMatchObject(general);
    expect(resolveGfCostTariff(book(tariffs, [agreement({ effective_from: "2026-10-10" })]), lookup("Ate"))).toMatchObject(general);
    expect(resolveGfCostTariff(book(tariffs, [agreement({ effective_to: "2026-09-30" })]), lookup("Ate"))).toMatchObject(general);
  });

  it("distrito por el catálogo canónico y sus alias, como el Tarifario y Rutas", () => {
    const tariffs = [
      rate({ id: "surco", district_key: "santiago de surco", delivery_amount: 13 }),
      rate({ id: "lurigancho", district_key: "lurigancho", delivery_amount: 22 }),
      rate({ id: "sjl", district_key: "san juan de lurigancho", delivery_amount: 11 }),
    ];
    const amount = (district: string) => {
      const t = resolveGfCostTariff(book(tariffs), lookup(district));
      return t.kind === "found" ? t.amount : t.reason;
    };
    expect(amount("Surco")).toBe(13);
    expect(amount("Santiago de Surco")).toBe(13);
    // Chosica y Lurigancho Chosica comparten la tarifa de Lurigancho (MOM §29.8).
    expect(amount("Chosica")).toBe(22);
    expect(amount("Lurigancho Chosica")).toBe(22);
    expect(amount("Lurigancho")).toBe(22);
    expect(amount("SJL")).toBe(11);
    expect(amount("San Juan de Lurigancho")).toBe(11);
  });

  it("un distrito que no se reconoce, o ninguno: sin distrito, no una tarifa inventada", () => {
    expect(resolveGfCostTariff(book([rate({})]), lookup("Zzz"))).toEqual({
      kind: "missing",
      reason: "sin_distrito",
      since: null,
      districtKey: null,
    });
    expect(resolveGfCostTariff(book([rate({})]), lookup(null))).toMatchObject({ kind: "missing", reason: "sin_distrito" });
  });

  it("un distrito sin tarifa en el Tarifario: sin tarifa", () => {
    expect(resolveGfCostTariff(book([rate({ district_key: "ate" })]), lookup("Miraflores"))).toEqual({
      kind: "missing",
      reason: "sin_tarifa",
      since: null,
      districtKey: "miraflores",
    });
  });

  it("antes de la vigencia: sin tarifa, y desde cuándo rige la del distrito (de los datos)", () => {
    // El día del costo es el último movimiento (`costDay`): uno anterior al
    // 31-08-2026 no tiene tarifa en el Tarifario medido el 20-10-2026.
    expect(resolveGfCostTariff(book([rate({})]), lookup("Ate", "2026-08-20"))).toEqual({
      kind: "missing",
      reason: "antes_de_vigencia",
      since: "2026-08-31",
      districtKey: "ate",
    });
    // Rige el mismo día en que empieza: extremos inclusive.
    expect(resolveGfCostTariff(book([rate({})]), lookup("Ate", "2026-08-31"))).toMatchObject({ kind: "found", amount: 12 });
    // La fecha la ponen los datos, no el código: con otra vigencia, otra fecha.
    expect(resolveGfCostTariff(book([rate({ effective_from: "2026-09-15" })]), lookup("Ate", "2026-09-01"))).toMatchObject({
      reason: "antes_de_vigencia",
      since: "2026-09-15",
    });
  });

  it("una vigencia cerrada antes del día, o una tarifa inactiva, no cuentan", () => {
    expect(resolveGfCostTariff(book([rate({ effective_to: "2026-09-30" })]), lookup("Ate"))).toMatchObject({
      kind: "missing",
      reason: "sin_tarifa",
    });
    expect(resolveGfCostTariff(book([rate({ status: "inactive" })]), lookup("Ate"))).toMatchObject({
      kind: "missing",
      reason: "sin_tarifa",
    });
    // Una corrección posterior del mismo ámbito gana desde su día.
    const tariffs = [rate({ id: "v1", effective_to: "2026-09-30" }), rate({ id: "v2", effective_from: "2026-10-01", delivery_amount: 14 })];
    expect(resolveGfCostTariff(book(tariffs), lookup("Ate", "2026-09-30"))).toMatchObject({ tariffId: "v1", amount: 12 });
    expect(resolveGfCostTariff(book(tariffs), lookup("Ate", "2026-10-02"))).toMatchObject({ tariffId: "v2", amount: 14 });
  });

  it("sin Grupo GF Courier en la organización: sin proveedor", () => {
    expect(resolveGfCostTariff({ ...book([rate({})]), providerByOrg: new Map() }, lookup("Ate"))).toMatchObject({
      kind: "missing",
      reason: "sin_proveedor",
    });
  });

  it("un Tarifario que no se pudo leer, o una tienda sin organización leída: sin lectura, no sin proveedor", () => {
    expect(resolveGfCostTariff(UNREADABLE_GF_TARIFF_BOOK, lookup("Ate"))).toEqual({
      kind: "missing",
      reason: "sin_lectura",
      since: null,
      districtKey: "ate",
    });
    expect(resolveGfCostTariff(book([rate({})]), { ...lookup("Ate"), orgId: null })).toMatchObject({ reason: "sin_lectura" });
  });
});

describe("computeLogisticsCost con «propio»: el Tarifario, nunca cost_tariffs", () => {
  const costTariff = (over: Partial<CostTariff>): CostTariff => ({
    id: over.id ?? "c",
    store_id: null,
    courier: null,
    region: null,
    province: null,
    district: null,
    concept: "primer_intento",
    amount: 99,
    effective_from: "2026-01-01",
    effective_to: null,
    ...over,
  });
  // Una tarifa de Costos que, si se mirara, le aplicaría a todo (sin courier).
  const costos = [
    costTariff({ id: "p", concept: "primer_intento", amount: 99 }),
    costTariff({ id: "a", concept: "intento_adicional", amount: 50 }),
    costTariff({ id: "d", concept: "devolucion", amount: 30 }),
    costTariff({ id: "g", concept: "envio_agencia", amount: 18 }),
  ];
  const own: LogisticsCostInput = {
    ctx: { storeId: KENKU, courier: "propio", region: "Lima", province: "Lima", district: "Ate" },
    attempts: 1,
    generalStatus: "entregado",
    agency: false,
    day: "2026-10-02",
    ownDistrictRate: 12,
  };

  it("primer intento: el importe del distrito", () => {
    const r = computeLogisticsCost(costos, own);
    expect(r).toEqual({
      total: 12,
      lines: [{ concept: "primer_intento", amount: 12, quantity: 1, source: "tarifario" }],
      missing: [],
    });
  });

  it("cada intento adicional de sus propias salidas cobra el mismo importe (los cuenta quien llama)", () => {
    const r = computeLogisticsCost(costos, { ...own, attempts: 3 });
    expect(r.total).toBe(36);
    expect(r.lines).toEqual([
      { concept: "primer_intento", amount: 12, quantity: 1, source: "tarifario" },
      { concept: "intento_adicional", amount: 24, quantity: 2, source: "tarifario" },
    ]);
    // Sin intentos reportados se asume uno, como para cualquier courier.
    expect(computeLogisticsCost(costos, { ...own, attempts: 0 }).total).toBe(12);
  });

  it("sin devolución aparte: el rechazo ya pagó la tarifa del distrito (§29.8)", () => {
    const r = computeLogisticsCost(costos, { ...own, attempts: 1, generalStatus: "devuelto" });
    expect(r.lines.map((l) => l.concept)).toEqual(["primer_intento"]);
    expect(r.total).toBe(12);
  });

  it("sin tarifa del Tarifario: falta, aunque Costos tenga una que le aplicaría", () => {
    const r = computeLogisticsCost(costos, { ...own, attempts: 2, ownDistrictRate: null });
    expect(r).toEqual({ total: 0, lines: [], missing: ["primer_intento", "intento_adicional"] });
    expect(masterLogisticsCost(costos, { ...own, ownDistrictRate: undefined })).toEqual({ cost: null, missing: ["primer_intento"] });
    expect(masterLogisticsCost(costos, own)).toEqual({ cost: 12, missing: [] });
  });

  it("una tarifa de S/ 0 en el Tarifario es un cero legítimo", () => {
    expect(masterLogisticsCost(costos, { ...own, ownDistrictRate: 0 })).toEqual({ cost: 0, missing: [] });
  });

  it("el envío por agencia no es reparto por distrito: sigue en Costos", () => {
    const r = computeLogisticsCost(costos, { ...own, agency: true });
    expect(r.lines).toEqual([{ concept: "envio_agencia", amount: 18, quantity: 1, source: "tarifa" }]);
  });

  it("otro courier, sin cambios: Costos, y el Tarifario no se mira", () => {
    const urpi = { ...own, ctx: { ...own.ctx, courier: "urpi" }, attempts: 2, generalStatus: "devuelto" };
    const r = computeLogisticsCost(costos, urpi);
    expect(r.total).toBe(99 + 50 + 30);
    expect(r.lines.every((l) => l.source === "tarifa")).toBe(true);
    expect(masterLogisticsCost([], { ...urpi, ownDistrictRate: 12 })).toEqual({
      cost: null,
      missing: ["primer_intento", "intento_adicional", "devolucion"],
    });
  });

  it("«propio» se reconoce como lo escriban; «por definir» y vacío no son Grupo GF", () => {
    expect(isOwnCourier("propio")).toBe(true);
    expect(isOwnCourier(" Propio ")).toBe(true);
    expect(isOwnCourier("por_definir")).toBe(false);
    expect(isOwnCourier(null)).toBe(false);
    expect(isOwnCourier("gf:Roy")).toBe(false);
  });
});

describe("liquidationCostBlock con Grupo GF: manda al Tarifario", () => {
  const base = { cost: null, missing: ["primer_intento"], courier: "propio", district: "Ate", day: "2026-10-02" } as const;

  it("sin el motivo (la Mesa sin ficha): el Tarifario, el día y el permiso; no Costos ni conceptos", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing] })!;
    expect(text).toBe(
      "Falta la tarifa de Grupo GF para Ate en su Tarifario. Sin ella el flete quedaría en S/ 0 y la liquidación no" +
        " cuadra. Cárgala en Grupo GF Courier › Tarifario, vigente desde el 02-10-2026 o antes, y vuelve a conciliar." +
        " Una que empiece después de ese día no le llega: el costo se calcula con la del día de su último movimiento.",
    );
    expect(text).not.toContain("Costos › Costos logísticos");
    expect(text).not.toContain("«Primer intento»");
  });

  it("sin `logistics.manage`: a quién pedírsela, con el nombre del permiso", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], canManageLogistics: false, canManageCosts: true })!;
    expect(text).toContain(
      `Pídele a quien administra Grupo GF («${GF_TARIFF_PERMISSION_LABEL}») que la cargue en ${GF_TARIFF_SCREEN_LABEL},` +
        " vigente desde el 02-10-2026 o antes, y luego vuelve a conciliar.",
    );
    expect(GF_TARIFF_PERMISSION_LABEL).toBe("Administrar Grupo GF");
    expect(text).not.toContain("Cárgala");
  });

  it("sin tarifa del distrito: lo dice y manda a cargarla", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], tarifario: { reason: "sin_tarifa", since: null } })!;
    expect(text).toContain("Falta la tarifa de Grupo GF para Ate: su Tarifario no tiene ninguna vigente para ese distrito.");
    expect(text).toContain("Cárgala en Grupo GF Courier › Tarifario, vigente desde el 02-10-2026 o antes");
  });

  it("antes de la vigencia: la fecha de los datos, y no manda a cargar lo que la pantalla no deja", () => {
    const text = liquidationCostBlock({
      ...base,
      missing: [...base.missing],
      day: "2026-08-20",
      tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" },
    })!;
    expect(text).toBe(
      "Falta la tarifa de Grupo GF para Ate del 20-08-2026: en Grupo GF Courier › Tarifario la de ese distrito rige" +
        " desde el 31-08-2026, y el costo se calcula con la del día de su último movimiento. Sin ella el flete quedaría" +
        " en S/ 0 y la liquidación no cuadra. El Tarifario solo abre vigencias después de la que rige, así que una" +
        " tarifa para antes del 31-08-2026 no se carga desde la pantalla: lo decide el dueño.",
    );
    expect(text).not.toContain("Cárgala");
  });

  it("un distrito que no se reconoce se corrige en el pedido, también sin el dato del servidor", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], district: "Zzz" })!;
    expect(text).toContain("el distrito «Zzz» no se reconoce en el catálogo de Lima");
    expect(text).toContain("Corrige el distrito en el pedido");
    expect(text).not.toContain("Cárgala");
    expect(liquidationCostBlock({ ...base, missing: [...base.missing], district: null })).toContain(
      "Falta la tarifa de Grupo GF: el pedido no tiene distrito",
    );
  });

  it("sin proveedor de Grupo GF lo dice", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], tarifario: { reason: "sin_proveedor", since: null } })!;
    expect(text).toContain("Grupo GF Courier no está activado en esta organización");
  });

  it("sin leer el Tarifario no afirma que falte: pide volver a intentarlo, sin mandar a activar ni a cargar", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], tarifario: { reason: "sin_lectura", since: null } })!;
    expect(text).toBe(
      "No se pudo leer Grupo GF Courier › Tarifario, así que falta la tarifa de Grupo GF para Ate. Sin ella el flete" +
        " quedaría en S/ 0 y la liquidación no cuadra. Vuelve a conciliar en un momento: es un error de lectura, no una" +
        " tarifa que cargar.",
    );
    expect(text).not.toContain("no está activado");
    expect(text).not.toContain("Cárgala");
  });

  it("la ficha la encontró y la fila está vieja: no pide cargar una tarifa que ya existe", () => {
    const text = liquidationCostBlock({ ...base, missing: [...base.missing], tarifario: { reason: "vigente", since: null } })!;
    expect(text).toBe(
      "Grupo GF Courier › Tarifario ya tiene la tarifa de Grupo GF para Ate del 02-10-2026, pero este pedido todavía no" +
        " la tiene en su costo. «Conciliar liquidación» lo vuelve a calcular al guardar; si falta otra cosa, lo dirá.",
    );
    expect(text).not.toContain("Cárgala");
  });

  it("el envío por agencia que falta sigue en Costos", () => {
    const text = liquidationCostBlock({ ...base, missing: ["envio_agencia"] })!;
    expect(text).toContain("Costos › Costos logísticos (courier «propio»)");
  });

  it("solo una tarifa que la pantalla deja cargar arregla el bloqueo; el enlace es el del Tarifario", () => {
    expect(costBlockNeedsTariff({ ...base })).toBe(true);
    expect(costBlockNeedsTariff({ ...base, tarifario: { reason: "sin_tarifa", since: null } })).toBe(true);
    expect(costBlockNeedsTariff({ ...base, tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" } })).toBe(false);
    expect(costBlockNeedsTariff({ ...base, tarifario: { reason: "sin_lectura", since: null } })).toBe(false);
    expect(costBlockNeedsTariff({ ...base, tarifario: { reason: "vigente", since: null } })).toBe(false);
    expect(costBlockNeedsTariff({ ...base, district: "Zzz" })).toBe(false);
    expect(costTariffScreen(base)).toEqual({ href: GF_TARIFF_SCREEN_HREF, link: "Abrir Tarifario", permission: "logistics.manage" });
    expect(GF_TARIFF_SCREEN_HREF).toBe("/dashboard/courier?tab=tariffs");
    expect(costTariffScreen({ courier: "urpi" })).toMatchObject({ href: "/dashboard/costos", permission: "costs.manage" });
    expect(costTariffScreen({ courier: "propio", missing: ["envio_agencia"] })).toMatchObject({ permission: "costs.manage" });
  });
});
