import { pickupCodeError } from "@/lib/shalom/draft";

/**
 * Datos que el operador copia de pro.shalom.pe cuando la integración de
 * creación no está disponible. El número de guía es el único dato necesario
 * para que el rastreo público vuelva a funcionar; los demás enriquecen las
 * operaciones que requieren identificadores internos de Shalom.
 */
export interface ManualShalomGuideInput {
  guideCode: string;
  codigo?: string | null;
  pickupCode?: string | null;
  agencyBranch?: string | null;
  serie?: string | null;
  oseId?: string | number | null;
  shalomOrderId?: string | number | null;
}

export interface NormalizedManualShalomGuide {
  guideCode: string;
  codigo: string | null;
  pickupCode: string | null;
  agencyBranch: string | null;
  serie: string | null;
  oseId: number | null;
  shalomOrderId: number | null;
}

export type ManualShalomGuideResult =
  | { ok: true; value: NormalizedManualShalomGuide }
  | { ok: false; error: string };

function optionalText(raw: string | null | undefined, max: number): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  return value ? value.slice(0, max) : null;
}

function optionalPositiveInteger(
  raw: string | number | null | undefined,
  label: string,
): { value: number | null; error?: string } {
  if (raw == null || String(raw).trim() === "") return { value: null };
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { value: null, error: `${label} debe contener solo dígitos.` };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { value: null, error: `${label} no es un identificador válido.` };
  }
  return { value };
}

export function normalizeManualShalomGuide(
  input: ManualShalomGuideInput,
): ManualShalomGuideResult {
  const guideCode = (input.guideCode ?? "").trim().replace(/\s+/g, "").toUpperCase();
  if (!guideCode) return { ok: false, error: "Ingresa el número de guía creado en Shalom Pro." };
  if (guideCode.length < 3 || guideCode.length > 64 || !/^[A-Z0-9._/-]+$/.test(guideCode)) {
    return {
      ok: false,
      error: "El número de guía solo puede contener letras, números, punto, guion o barra.",
    };
  }

  const codigo = (input.codigo ?? "").trim().replace(/\s+/g, "").toUpperCase() || null;
  if (codigo && (codigo.length > 32 || !/^[A-Z0-9._/-]+$/.test(codigo))) {
    return { ok: false, error: "El código Shalom no tiene un formato válido." };
  }

  const pickupCode = (input.pickupCode ?? "").trim() || null;
  if (pickupCode) {
    const keyError = pickupCodeError(pickupCode);
    if (keyError) return { ok: false, error: `Clave de recojo: ${keyError}` };
  }

  const ose = optionalPositiveInteger(input.oseId, "El OSE ID");
  if (ose.error) return { ok: false, error: ose.error };
  const order = optionalPositiveInteger(input.shalomOrderId, "El ID de orden Shalom");
  if (order.error) return { ok: false, error: order.error };

  return {
    ok: true,
    value: {
      guideCode,
      codigo,
      pickupCode,
      agencyBranch: optionalText(input.agencyBranch, 240),
      serie: optionalText(input.serie, 32),
      oseId: ose.value,
      shalomOrderId: order.value,
    },
  };
}
