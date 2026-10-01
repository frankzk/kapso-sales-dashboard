import type { SupabaseClient } from "@supabase/supabase-js";
import { createGuide, swaypOptsFromEnv, type SwaypCreateGuideInput } from "@/lib/swayp";

export interface AutoEmission {
  evidence: Record<string, unknown>;
  stock: { codbar: string; disponible: number }[];
  readAt: string;
}
/** Persist the claim before the only POST. Neither crashes nor timeouts unlock it. */
export async function emitSwaypOnce(args: {
  admin: SupabaseClient; storeId: string; orderId: string; sourceKey: string; city: string;
  input: SwaypCreateGuideInput; automatic?: AutoEmission;
}): Promise<{ ok: true; guia: string; idEstado: number } | { ok: false; reason: string }> {
  const { admin, automatic } = args;
  const { data, error } = await admin.rpc("swayp_emission_claim", {
    p_store: args.storeId, p_order: args.orderId, p_key: args.sourceKey, p_city: args.city,
    p_products: args.input.productos ?? [], p_auto: !!automatic, p_evidence: automatic?.evidence ?? {},
    p_stock: automatic?.stock ?? null, p_read_at: automatic?.readAt ?? null,
  });
  if (error || !data?.id) return { ok: false, reason: error?.message ?? data?.error ?? "No se pudo reservar la emisión" };
  const id = String(data.id);
  try {
    const result = await createGuide(swaypOptsFromEnv(), args.input);
    const guia = String(result.guia);
    const saved = await admin.from("swayp_guide_emissions").update({ state: "created", guide_code: guia, swayp_state: result.idEstado }).eq("id",id);
    if (saved.error) {
      // Do not lose the issued number even if local persistence is unavailable.
      console.error("[swayp-emission] Guía emitida sin guardar", { id, guia });
      return { ok: false, reason: `Swayp emitió ${guia}, pero falta registrarla. Revisar emisión ${id}; no repetir.` };
    }
    return { ok: true, guia, idEstado: result.idEstado };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Respuesta desconocida de Swayp";
    await admin.from("swayp_guide_emissions").update({ state: "review", error: message.slice(0,1000) }).eq("id",id);
    return { ok: false, reason: `Emisión ${id} pendiente de revisión: ${message}. No se repetirá automáticamente.` };
  }
}
