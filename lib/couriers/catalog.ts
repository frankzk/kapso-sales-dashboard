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

export const GROUP_GF_RIDER_COURIER = "Grupo GF Courier";

/**
 * Las fichas históricas de motorizados propios guardaban courier nulo. El
 * nombre formal nuevo convive con ese alias para no reescribir IDs ni romper
 * rutas o liquidaciones anteriores.
 */
export function isGroupGfRiderCourier(value: string | null | undefined): boolean {
  const key = courierKey(value);
  return !key || ["propio", "motorizado propio", "grupo gf courier"].includes(key);
}

export interface CourierOption {
  /** Identificador estable de la opción (para el <select>). */
  key: string;
  /** Token guardado en el manifiesto; calza con shipments.courier. */
  value: string;
  /** Etiqueta visible. */
  label: string;
}

export const DISPATCH_COURIERS: readonly CourierOption[] = [
  { key: "propios", value: "propio", label: GROUP_GF_RIDER_COURIER },
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
/**
 * Una opción del desplegable de "Nueva ruta": o un motorizado propio concreto,
 * o un courier.
 */
export interface RouteChoice {
  /** Valor del `<option>`; codifica de cuál de los dos casos se trata. */
  value: string;
  label: string;
  /** Token que se guarda en `dispatch_manifests.courier`. */
  courier: string;
  riderId: string | null;
}

/**
 * Las opciones de "Nueva ruta", en un solo desplegable.
 *
 * POR QUÉ UN SOLO DESPLEGABLE. Antes eran dos —courier y luego motorizado—, y el
 * segundo solo tenía sentido para los motorizados propios: para Aliclik, Urpi o
 * Tanders la ruta ES el courier y no se sabe quién conduce. Elegir dos veces
 * para decir una sola cosa invitaba a dejar «Sin asignar» sin querer.
 *
 * Los motorizados propios van agrupados bajo su propia cabecera, así que la
 * lista se lee como lo que es: «con quién sale la caja».
 */
export function routeChoices<T extends { id: string; full_name: string; courier: string | null }>(
  riders: readonly T[],
): { own: RouteChoice[]; couriers: RouteChoice[] } {
  const ownRiders = riders.filter((rider) => isGroupGfRiderCourier(rider.courier));
  const own: RouteChoice[] = ownRiders.map((rider) => ({
    value: `rider:${rider.id}`,
    label: rider.full_name,
    courier: "propio",
    riderId: rider.id,
  }));
  // Sin fichas registradas, la opción genérica evita dejar el grupo vacío y
  // bloquear el alta de una ruta propia.
  if (!own.length) {
    own.push({ value: "courier:propios", label: "Sin asignar", courier: "propio", riderId: null });
  }
  const couriers = DISPATCH_COURIERS.filter((option) => option.key !== "propios").map((option) => ({
    value: `courier:${option.key}`,
    label: option.label,
    courier: option.value,
    riderId: null,
  }));
  return { own, couriers };
}

/** Busca la opción elegida entre todas las del desplegable. */
export function routeChoiceByValue<T extends { id: string; full_name: string; courier: string | null }>(
  riders: readonly T[],
  value: string,
): RouteChoice | null {
  const { own, couriers } = routeChoices(riders);
  return [...own, ...couriers].find((choice) => choice.value === value) ?? null;
}

export function ridersForCourier<T extends { courier: string | null }>(
  riders: readonly T[],
  option: CourierOption | null,
): T[] {
  if (!option) return [];
  if (option.key === "propios") {
    return riders.filter((r) => isGroupGfRiderCourier(r.courier));
  }
  const candidates = [option.key, courierKey(option.label), courierKey(option.value)];
  return riders.filter((r) => {
    const rk = courierKey(r.courier);
    if (!rk) return false;
    return candidates.includes(rk) || rk.includes(option.key);
  });
}
