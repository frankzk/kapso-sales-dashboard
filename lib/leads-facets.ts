/**
 * Facetas de la cola de Leads en UNA sola pasada.
 *
 * El tablero muestra, para cada grupo de filtros (fuente, número, estado,
 * segmento, gestión, ventana…), cuántos leads caerían en cada opción si se
 * eligiera. La regla es que un grupo NO se filtra a sí mismo: sus contadores se
 * calculan sobre los leads que pasan todos los DEMÁS filtros activos.
 *
 * Eso son siete bases distintas. Calcularlas como siete `leads.filter(...)`
 * significaba evaluar los ocho predicados sobre los ~2.500 leads de la cola
 * siete veces — unas 140.000 comprobaciones — y volver a hacerlo entero en CADA
 * render: cada tecla del buscador, cada chip, cada refresco en vivo.
 *
 * Aquí se evalúan los predicados UNA vez por lead y se guarda, en un entero, qué
 * facetas falla. Después cada base es una comparación de bits:
 *
 *   - pasa todo            → máscara 0
 *   - pasa todo menos `k`  → máscara sin bits fuera de `k`
 *
 * El coste pasa de O(n · facetas²) a O(n · facetas), y el resultado es idéntico.
 * Puro y sin React a propósito, para poder probarlo.
 */

export interface FacetedItems<T, K extends string> {
  /** Los que pasan TODAS las facetas (la lista que se muestra). */
  all: T[];
  /** Los que pasan todas menos las indicadas: la base de contadores de ese grupo. */
  except: (...skip: K[]) => T[];
  /** Mismo criterio que `all`, para reaplicarlo a filas que no venían en la lista. */
  matchesAll: (item: T) => boolean;
}

export function facetItems<T, K extends string>(
  items: readonly T[],
  predicates: Record<K, (item: T) => boolean>,
): FacetedItems<T, K> {
  const keys = Object.keys(predicates) as K[];
  if (keys.length > 31) {
    // Nunca ha habido más de nueve; con más de 31 los bits no caben en un entero
    // de 32 bits y los contadores empezarían a mentir en silencio.
    throw new Error(`facetItems admite hasta 31 facetas, recibió ${keys.length}`);
  }
  const bit = new Map<K, number>(keys.map((key, index) => [key, 1 << index]));

  // Una pasada: por cada lead, qué facetas FALLA.
  const failed = new Array<number>(items.length);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let mask = 0;
    for (let k = 0; k < keys.length; k++) {
      if (!predicates[keys[k]!]!(item)) mask |= 1 << k;
    }
    failed[i] = mask;
  }

  const collect = (allowed: number): T[] => {
    const out: T[] = [];
    for (let i = 0; i < items.length; i++) {
      if ((failed[i]! & ~allowed) === 0) out.push(items[i]!);
    }
    return out;
  };

  return {
    all: collect(0),
    except: (...skip: K[]) => collect(skip.reduce((acc, key) => acc | (bit.get(key) ?? 0), 0)),
    matchesAll: (item: T) => keys.every((key) => predicates[key]!(item)),
  };
}
