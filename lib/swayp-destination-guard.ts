// Guarda contra un destino Swayp contradictorio (02-11-2026, #KP142611, MOM §19.0.2).
//
// QUÉ PASÓ. Un pedido de provincia COD de La Victoria, Chiclayo, tenía en el
// Master la provincia «lima» (un homónimo aprendido por nombre de distrito, ver
// `limaProvinceTrusted` en lib/district-learning.ts). La salida la copió, el
// agente de voz confirmó un reenvío por Swayp, y la guía derivó su ciudad de
// «La Victoria» + «lima» (`deriveFenixCoverageCity`): Swayp la imprimió
// «Distrito: La Victoria (Lima)» y la sacó a reparto en Lima. Nada paraba una
// guía Swayp de Lima para un pedido que el propio Master clasifica como
// provincia COD.
//
// LA REGLA. Antes de crear CUALQUIER guía Swayp, si su ciudad resuelve a Lima
// Metropolitana o el Callao y el pedido dice que no es de Lima —su cobertura es
// Provincia COD o Agencia, su región es un departamento que no es Lima (una
// provincia capital se lee como su departamento: «Chiclayo» → Lambayeque) o su
// pin cae claramente fuera de Lima—, no se crea. Se arregla la ubicación del
// pedido y se vuelve a intentar. Una guía a una ciudad Fenix de provincia
// (Chiclayo, Arequipa…) no se toca.
//
// Una función pura y un lector: la pura la usan las pruebas y las rejas que ya
// tienen la fila del Master; el lector, los caminos que crean la guía.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ORDER_COVERAGE_LABEL, type OrderCoverage } from "@/lib/order-coverage";
import {
  departmentFromCapitalProvince,
  normalizeDepartment,
  orderDepartmentKey,
  pinInLimaMetro,
} from "@/lib/peru-departamentos";
import { fenixWarehouseKey, normalizeCity } from "@/lib/shipments";

/** Lo que el pedido dice de su destino, leído de su fila del Master. */
export interface SwaypDestinationEvidence {
  coverage?: string | null;
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** ¿La ciudad de la guía es Lima Metropolitana o el Callao? */
export function isLimaSwaypDestination(city: string | null | undefined): boolean {
  const c = normalizeCity(city);
  return c === "lima" || c === "callao" || fenixWarehouseKey(c) === "lima";
}

const NO_LIMA_COVERAGE = new Set<string>(["provincia_cod", "agencia"]);

function coordenada(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Por qué NO se puede crear una guía Swayp a `city` para este pedido, o null si
 * no hay contradicción. Solo juzga destinos de Lima/Callao: una guía de
 * provincia nunca se frena aquí.
 */
export function swaypDestinationContradiction(
  city: string | null | undefined,
  evidence: SwaypDestinationEvidence | null | undefined,
): string | null {
  if (!isLimaSwaypDestination(city) || !evidence) return null;

  const coverage = evidence.coverage && NO_LIMA_COVERAGE.has(evidence.coverage) ? evidence.coverage : null;
  const regionText = evidence.region?.trim() || null;
  const dep = orderDepartmentKey(regionText);
  const regionNoLima = dep !== null && dep !== "lima";
  const pinFuera = pinInLimaMetro(evidence.latitude, evidence.longitude) === false;
  if (!coverage && !regionNoLima && !pinFuera) return null;

  const coverageLabel = coverage ? ORDER_COVERAGE_LABEL[coverage as OrderCoverage] : null;
  let region: string | null = null;
  if (regionNoLima && regionText) {
    const capital = departmentFromCapitalProvince(regionText);
    region = capital ? `${regionText} (${capital})` : (normalizeDepartment(regionText) ?? regionText);
  }
  const desc =
    region && coverageLabel
      ? `${region}, ${coverageLabel}`
      : (region ??
        coverageLabel ??
        `una ubicación fuera de Lima (${coordenada(Number(evidence.latitude))}, ${coordenada(Number(evidence.longitude))})`);
  return (
    `Destino contradictorio: la guía Swayp saldría a Lima, pero el pedido es de ${desc}. ` +
    "Revisa la ubicación del pedido (Corregir ubicación) antes de crear la guía."
  );
}

/**
 * La misma guarda, leyendo la evidencia de la fila del Master del pedido.
 *
 * No lee nada si el destino no es Lima. Si la lectura falla, NO deja pasar la
 * guía: una guía mal dirigida es un paquete que viaja al sitio equivocado, y
 * reintentar cuesta un clic.
 */
export async function swaypDestinationRefusal(
  admin: SupabaseClient,
  orderId: string | null | undefined,
  city: string | null | undefined,
): Promise<string | null> {
  if (!orderId || !isLimaSwaypDestination(city)) return null;
  const { data, error } = await admin
    .from("order_master")
    .select("coverage,region,latitude,longitude")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) return `No se pudo comprobar el destino del pedido antes de crear la guía Swayp: ${error.message}`;
  return swaypDestinationContradiction(city, (data as SwaypDestinationEvidence | null) ?? null);
}
