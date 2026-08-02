// Catálogo de transportadoras para la Mesa de despacho. Hoy los couriers están
// dispersos (SETTLEMENT_COURIERS, adaptadores de ingesta); esta lista es la que
// alimenta el desplegable de "Nueva ruta". No pretende reemplazar a las demás:
// solo da una lista estable para elegir courier + motorizado.
//
// `value` es el token que se GUARDA en dispatch_manifests.courier: tiene que
// calzar con `shipments.courier` porque al agregar un paquete se compara
// `courierKey(shipment.courier) === courierKey(manifest.courier)`. Por eso Swayp
// se guarda como `fenix` (el token legado que usan los envíos), aunque se muestre
// como "Swayp (antes Fénix)" — MOM §5.

import { courierKey } from "@/lib/dispatch";

export interface CourierOption {
  /** Identificador estable de la opción (para el <select>). */
  key: string;
  /** Token guardado en el manifiesto; calza con shipments.courier. */
  value: string;
  /** Etiqueta visible. */
  label: string;
}

export const DISPATCH_COURIERS: readonly CourierOption[] = [
  { key: "propios", value: "propio", label: "Motorizados propios" },
  { key: "aliclik", value: "aliclik", label: "Aliclik" },
  { key: "swayp", value: "fenix", label: "Swayp (antes Fénix)" },
  { key: "shalom", value: "shalom", label: "Shalom" },
  { key: "tanders", value: "tanders", label: "Tanders" },
  { key: "axel", value: "axel", label: "Axel Courier" },
  { key: "urpi", value: "urpi", label: "Urpi" },
  { key: "olva", value: "olva", label: "Olva" },
] as const;

export function courierOptionByKey(key: string): CourierOption | null {
  return DISPATCH_COURIERS.find((c) => c.key === key) ?? null;
}

/** Etiqueta visible para un courier guardado (token). Cae al valor crudo si no está en el catálogo. */
export function courierLabelFor(value: string | null | undefined): string {
  if (!value) return "—";
  const k = courierKey(value);
  return DISPATCH_COURIERS.find((c) => courierKey(c.value) === k)?.label ?? value;
}

/**
 * Motorizados que corresponden al courier elegido. `propios` = fichas sin
 * transportadora; para el resto se compara la transportadora de la ficha con el
 * courier sin distinguir mayúsculas ni acentos, y de forma tolerante (una ficha
 * "Axel" calza con "Axel Courier"). El llamador siempre ofrece además
 * «Sin asignar», así que una lista vacía no bloquea crear la ruta.
 */
export function ridersForCourier<T extends { courier: string | null }>(
  riders: readonly T[],
  option: CourierOption | null,
): T[] {
  if (!option) return [];
  if (option.key === "propios") {
    return riders.filter((r) => !r.courier || !r.courier.trim());
  }
  const candidates = [option.key, courierKey(option.label), courierKey(option.value)];
  return riders.filter((r) => {
    const rk = courierKey(r.courier);
    if (!rk) return false;
    return candidates.includes(rk) || rk.includes(option.key);
  });
}
