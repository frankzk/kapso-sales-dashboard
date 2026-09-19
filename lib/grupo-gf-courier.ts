/** Reglas puras de Grupo GF Courier (MOM §29). Sin IO ni dependencia de UI. */

export const GROUP_GF_YAPE_PERCENTAGE = 3.5;

export type CourierOutcome =
  | "entregado"
  | "rechazado"
  | "no_responde"
  | "ausente"
  | "direccion_incorrecta"
  | "reprogramado"
  | "cancelado"
  | "incidencia_motorizado"
  | "paquete_observado";

export interface DistrictTariffRow {
  id: string;
  provider_id: string;
  agreement_id: string | null;
  district_key: string;
  zone: string | null;
  delivery_amount: number;
  rejection_amount: number;
  includes_igv: boolean;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  status: "active" | "inactive";
}

export interface DistrictAvailabilityEventRow {
  id: string;
  provider_id: string;
  agreement_id: string | null;
  district_key: string;
  action: "paused" | "reactivated";
  reason: string | null;
  paused_until: string | null;
  created_by: string | null;
  created_at: string;
}

export type DistrictAvailabilityResolution =
  | { status: "available"; source: "default" }
  | {
      status: "paused";
      source: "general" | "agreement";
      event: DistrictAvailabilityEventRow;
    };

export type TariffResolution =
  | { kind: "found"; tariff: DistrictTariffRow; source: "agreement" | "general" }
  | { kind: "missing"; reason: "district_without_tariff" };

/**
 * Resultado único para decidir si una salida nueva puede asignarse a Grupo GF.
 * Lo consume tanto la Mesa de ruta como el guard del servidor: así la tarjeta
 * no promete una salida que la acción vaya a rechazar después.
 */
export interface GroupGfCourierRouteCheck {
  known: boolean;
  eligible: boolean;
  reason: string;
  providerId: string | null;
  districtKey: string | null;
  agreementId: string | null;
  tariffId: string | null;
  tariffAmount: number | null;
  currency: string;
  sameDayCutoff: string;
}

function latestAvailabilityEvent(
  rows: readonly DistrictAvailabilityEventRow[],
  input: {
    providerId: string;
    agreementId: string | null;
    districtKey: string;
  },
): DistrictAvailabilityEventRow | null {
  return (
    rows
      .filter(
        (row) =>
          row.provider_id === input.providerId &&
          row.agreement_id === input.agreementId &&
          row.district_key === input.districtKey,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0] ?? null
  );
}

function isEffectivePause(event: DistrictAvailabilityEventRow | null, day: string): boolean {
  return (
    event?.action === "paused" &&
    (event.paused_until == null || event.paused_until >= day)
  );
}

/**
 * Resuelve la disponibilidad para una asignación nueva. Una pausa general
 * siempre gana; la pausa contractual solo afecta a su propia tienda.
 */
export function resolveDistrictAvailability(
  rows: readonly DistrictAvailabilityEventRow[],
  input: {
    providerId: string;
    agreementId: string | null;
    districtKey: string;
    day: string;
  },
): DistrictAvailabilityResolution {
  const general = latestAvailabilityEvent(rows, {
    providerId: input.providerId,
    agreementId: null,
    districtKey: input.districtKey,
  });
  if (isEffectivePause(general, input.day)) {
    return { status: "paused", source: "general", event: general! };
  }

  if (input.agreementId != null) {
    const agreement = latestAvailabilityEvent(rows, {
      providerId: input.providerId,
      agreementId: input.agreementId,
      districtKey: input.districtKey,
    });
    if (isEffectivePause(agreement, input.day)) {
      return { status: "paused", source: "agreement", event: agreement! };
    }
  }

  return { status: "available", source: "default" };
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validOn(row: DistrictTariffRow, day: string): boolean {
  return (
    row.status === "active" &&
    row.effective_from <= day &&
    (row.effective_to == null || row.effective_to >= day)
  );
}

/**
 * Resuelve una tarifa sin inventar S/0.
 *
 * La excepción del contrato gana sobre la general. Las tarifas de otro contrato
 * nunca participan y, dentro del mismo ámbito, gana la vigencia más reciente.
 */
export function resolveDistrictTariff(
  rows: readonly DistrictTariffRow[],
  input: {
    providerId: string;
    agreementId: string | null;
    districtKey: string;
    day: string;
  },
): TariffResolution {
  const candidates = rows
    .filter(
      (row) =>
        row.provider_id === input.providerId &&
        row.district_key === input.districtKey &&
        validOn(row, input.day) &&
        (row.agreement_id == null || row.agreement_id === input.agreementId),
    )
    .sort((a, b) => {
      const scopeA = a.agreement_id === input.agreementId && input.agreementId != null ? 1 : 0;
      const scopeB = b.agreement_id === input.agreementId && input.agreementId != null ? 1 : 0;
      if (scopeA !== scopeB) return scopeB - scopeA;
      return b.effective_from.localeCompare(a.effective_from) || b.id.localeCompare(a.id);
    });

  const tariff = candidates[0];
  if (!tariff) return { kind: "missing", reason: "district_without_tariff" };
  return {
    kind: "found",
    tariff,
    source: tariff.agreement_id == null ? "general" : "agreement",
  };
}

/** Solo entrega y rechazo generan tarifa; ambos usan el mismo importe distrital. */
export function tariffForOutcome(tariff: DistrictTariffRow, outcome: CourierOutcome): number {
  if (outcome === "entregado" || outcome === "rechazado") {
    return money(tariff.delivery_amount);
  }
  return 0;
}

/** Comisión sobre lo efectivamente recibido por Yape, no sobre todo el COD. */
export function yapeCommission(
  yapeCollected: number,
  percentage = GROUP_GF_YAPE_PERCENTAGE,
): number {
  if (!Number.isFinite(yapeCollected) || yapeCollected <= 0) return 0;
  if (!Number.isFinite(percentage) || percentage < 0) {
    throw new RangeError("El porcentaje de Yape no puede ser negativo.");
  }
  return money((yapeCollected * percentage) / 100);
}

export interface MerchantSettlementBreakdown {
  codCollected: number;
  logisticsFee: number;
  yapeFee: number;
  merchantNet: number;
}

/** Desglose visible: COD − envío/rechazo − Yape = neto de la tienda. */
export function merchantSettlement(input: {
  codCollected: number;
  yapeCollected: number;
  logisticsFee: number;
  yapePercentage?: number;
}): MerchantSettlementBreakdown {
  const codCollected = money(Math.max(0, input.codCollected));
  const logisticsFee = money(Math.max(0, input.logisticsFee));
  const yapeFee = yapeCommission(input.yapeCollected, input.yapePercentage);
  return {
    codCollected,
    logisticsFee,
    yapeFee,
    merchantNet: money(codCollected - logisticsFee - yapeFee),
  };
}

export type CashLimitStatus = "ok" | "warning" | "blocked";

export interface CashLimitVerdict {
  status: CashLimitStatus;
  /** Efectivo previsto en la ruta tras asignar: lo que ya lleva más lo nuevo. */
  total: number;
  message: string | null;
}

/**
 * Límites de efectivo de la ruta del día (MOM §29.9): el COD previsto no debe
 * pasar de `cash_limit_amount`; desde `cash_warning_amount` se avisa. Puro:
 * quien asigna suma lo que ya lleva la ruta y lo que quiere añadir.
 */
export function cashLimitVerdict(input: {
  currentCod: number;
  addingCod: number;
  warningAmount: number | null;
  limitAmount: number | null;
}): CashLimitVerdict {
  const total = Math.round((input.currentCod + input.addingCod) * 100) / 100;
  const fmt = (n: number) => `S/ ${n.toFixed(2)}`;
  if (input.limitAmount != null && input.limitAmount > 0 && total > input.limitAmount) {
    return {
      status: "blocked",
      total,
      message: `La ruta llevaría ${fmt(total)} en efectivo y el límite es ${fmt(input.limitAmount)}. Reparte los pedidos en otra ruta o autoriza superar el límite.`,
    };
  }
  if (input.warningAmount != null && input.warningAmount > 0 && total > input.warningAmount) {
    return {
      status: "warning",
      total,
      message: `Ojo: la ruta llevará ${fmt(total)} en efectivo, por encima del aviso de ${fmt(input.warningAmount)}.`,
    };
  }
  return { status: "ok", total, message: null };
}

// ---------------------------------------------------------------------------
// Verificación de la caja por el motorizado: un flag en la base (0175, §29.13)
// ---------------------------------------------------------------------------

export type RiderScreen = "recibir_caja" | "ruta";

/**
 * Qué ve el motorizado al abrir /reparto. Con la verificación activada, una
 * carga cotejada por oficina y sin custodia lo manda a «Recibir mi caja»; con
 * la verificación desactivada nunca ve esa pantalla: la custodia ya cambió al
 * asignar y lo que tiene es su ruta.
 */
export function riderScreenFor(pickupCheckRequired: boolean, loadStates: readonly string[]): RiderScreen {
  if (!pickupCheckRequired) return "ruta";
  return loadStates.some((state) => state === "ready_for_pickup" || state === "pickup_check") ? "recibir_caja" : "ruta";
}

/** Si al asignar hay que entregar la custodia en el acto (flag en false). */
export function custodyOnAssign(pickupCheckRequired: boolean): boolean {
  return !pickupCheckRequired;
}
