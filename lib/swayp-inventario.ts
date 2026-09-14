// Importador del "Inventario por bodega" que exporta el panel de Swayp.
//
// POR QUÉ EXISTE. `fenix_stock` se cargaba a mano y se fue separando de la
// realidad sin que nada avisara. Medido el 14-09-2026 contra dos exportaciones
// reales: Trujillo tenía 25 referencias / 177 unidades de nuestro lado y 17 /
// 116 del lado de Swayp; Juliaca 19 / 185 contra 7 / 165. Esa tabla es la reja
// que decide si el botón deja crear la guía, así que un saldo fantasma no es un
// número feo en una pantalla: autoriza guías que Swayp después rebota por falta
// de inventario (su motivo 18), con el pedido ya prometido al cliente.
//
// El Excel sale de Swayp → Stock → Inventario → "Enviar a Excel", una bodega
// por archivo. Columnas: Código de barras, Nombre, Empresa, Origen, Bodega,
// Ubicación, Disponible, En bodega, Reservado, En tránsito, Estado, Stock
// mínimo, Lote, Vencimiento, SKU.
//
// Este módulo es PURO: no lee la base ni la red. Recibe las filas ya parseadas
// y el estado actual, y devuelve el plan. Así el caso difícil —qué hacer con lo
// que sobra de nuestro lado— se prueba sin montar una base.

/** Fila del Excel, ya normalizada. */
export interface EntradaSwayp {
  /** Código de barras de Swayp (AURE001…). Es la identidad del producto allá. */
  codbar: string;
  nombre: string;
  bodega: string;
  /** Unidades que Swayp puede despachar HOY. Ver `COLUMNA_CANTIDAD`. */
  disponible: number;
}

/** Renglón de `fenix_stock` que nos importa para el plan. */
export interface FilaStock {
  id: string;
  city: string;
  product: string;
  sku: string | null;
  quantity: number;
  /** Sin control de cantidad: el importador no lo toca. */
  unlimited?: boolean;
}

/**
 * Qué columna del Excel es "el stock".
 *
 * «Disponible» y no «En bodega»: la segunda incluye lo reservado para guías ya
 * emitidas, que no se puede volver a prometer. En las exportaciones medidas las
 * dos coinciden porque Reservado va en 0, pero el día que no coincidan la que
 * responde «¿puedo crear otra guía?» es Disponible.
 */
export const COLUMNA_CANTIDAD = "Disponible";

/**
 * Nombre de bodega en Swayp → nuestra clave de ciudad.
 *
 * Se compara sin tildes, sin mayúsculas y sin el prefijo «bodega», porque en el
 * panel conviven «BODEGA TRUJILLO», «Bodega Arequipa» y «BODEGA JULIACA - PUNO».
 *
 * JULIACA Y PUNO COMPARTEN UNA SOLA BODEGA (ubigeo 211101) y acá se mapea SÓLO a
 * `juliaca`, que es la ciudad que hoy tiene renglones. Escribir las mismas
 * unidades también en `puno` haría que un mismo frasco habilite dos guías en dos
 * ciudades — exactamente el sobreprometer que este importador viene a cerrar.
 * Servir Puno desde esa bodega es una decisión de negocio que necesita que la
 * tabla tenga concepto de BODEGA y no de ciudad; hasta entonces, no se inventa.
 */
const BODEGA_A_CIUDAD: Record<string, string> = {
  arequipa: "arequipa",
  trujillo: "trujillo",
  "juliaca - puno": "juliaca",
  "juliaca-puno": "juliaca",
  juliaca: "juliaca",
  piura: "piura",
  lima: "lima",
};

function sinTildes(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Clave de ciudad para un nombre de bodega, o null si no la conocemos. */
export function ciudadDeBodega(bodega: string | null | undefined): string | null {
  const limpio = sinTildes(String(bodega ?? ""))
    .toLowerCase()
    .replace(/^\s*bodega\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!limpio) return null;
  return BODEGA_A_CIUDAD[limpio] ?? null;
}

/** Lee un entero de una celda; vacío o basura → 0. */
function entero(valor: string | undefined): number {
  const n = Number(String(valor ?? "").replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/** Busca una columna tolerando tildes, mayúsculas y espacios de más. */
function columna(fila: Record<string, string>, ...nombres: string[]): string {
  const claves = Object.keys(fila);
  for (const buscado of nombres) {
    const objetivo = sinTildes(buscado).toLowerCase().trim();
    const clave = claves.find((k) => sinTildes(k).toLowerCase().trim() === objetivo);
    if (clave && fila[clave]) return fila[clave];
  }
  return "";
}

export interface LecturaExcel {
  entradas: EntradaSwayp[];
  /** Bodegas distintas encontradas, tal cual las escribe Swayp. */
  bodegas: string[];
  /** Filas descartadas por no tener código de barras. */
  sinCodbar: number;
}

/**
 * Normaliza las filas crudas del Excel.
 *
 * Una fila sin código de barras se descarta y se cuenta: sin ese código no hay
 * forma de saber qué producto es, y adivinarlo por el nombre es justo el
 * emparejamiento flojo que nos trajo hasta acá.
 */
export function leerExcelSwayp(filas: Record<string, string>[]): LecturaExcel {
  const entradas: EntradaSwayp[] = [];
  const bodegas = new Set<string>();
  let sinCodbar = 0;

  for (const fila of filas) {
    const codbar = columna(fila, "Código de barras", "Codigo de barras", "Código de barra", "codbar")
      .trim()
      .toUpperCase();
    if (!codbar) {
      sinCodbar++;
      continue;
    }
    const bodega = columna(fila, "Bodega", "Almacén", "Warehouse").trim();
    if (bodega) bodegas.add(bodega);
    entradas.push({
      codbar,
      nombre: columna(fila, "Nombre", "Producto").trim(),
      bodega,
      disponible: entero(columna(fila, COLUMNA_CANTIDAD, "disponible")),
    });
  }

  // Swayp puede repetir un código en varias filas (lotes, ubicaciones): se suman,
  // porque lo que el panel muestra como "Disponible" de la referencia es el total.
  const porCodbar = new Map<string, EntradaSwayp>();
  for (const e of entradas) {
    const previa = porCodbar.get(e.codbar);
    if (previa) previa.disponible += e.disponible;
    else porCodbar.set(e.codbar, { ...e });
  }

  return { entradas: [...porCodbar.values()], bodegas: [...bodegas], sinCodbar };
}

/** Un renglón que hay que mover, con el saldo de antes y el de después. */
export interface Ajuste {
  id: string;
  product: string;
  sku: string | null;
  cantidadAnterior: number;
  cantidadNueva: number;
  codbar: string;
}

/** Un producto del Excel que no pudimos ubicar de nuestro lado. */
export interface Huerfano {
  codbar: string;
  nombre: string;
  disponible: number;
  /** `sin_vinculo`: el codbar no está en Catálogo. `sin_etiqueta`: está
   *  vinculado, pero ninguna ciudad tiene ese SKU, así que no sabemos con qué
   *  nombre darlo de alta. */
  motivo: "sin_vinculo" | "sin_etiqueta";
}

/** Un producto que Swayp tiene en esa bodega y nosotros no teníamos anotado. */
export interface Alta {
  sku: string;
  product: string;
  cantidad: number;
  codbar: string;
}

export interface PlanImportacion {
  ciudad: string;
  /** Renglones cuyo saldo cambia (incluye los que van a 0). */
  ajustes: Ajuste[];
  /** Renglones a crear: Swayp los tiene y esta ciudad no los tenía. */
  altas: Alta[];
  /** Renglones que ya coincidían: nada que escribir. */
  sinCambio: number;
  /** Renglones sin control de cantidad: el Excel no los gobierna. */
  sinControl: number;
  /** Productos del Excel que no tienen dónde aterrizar. */
  huerfanos: Huerfano[];
  totalSwayp: number;
  totalNuestro: number;
}

/**
 * Cruza el Excel de UNA bodega con nuestros renglones de ESA ciudad.
 *
 * LO QUE SOBRA DE NUESTRO LADO VA A CERO, y es el corazón de todo esto. La
 * exportación de una bodega es su inventario completo: si una referencia no
 * aparece, Swayp no la tiene. Dejarla con su saldo viejo sería conservar
 * justamente el número fantasma que autoriza guías imposibles. No se borra el
 * renglón —el producto sigue existiendo y mañana puede reponerse—, se pone en 0.
 *
 * SÓLO SE TOCA LA CIUDAD IMPORTADA. Nuestra tabla cubre nueve ciudades y Swayp
 * tiene cinco bodegas: Cusco, Huancayo, Ica, Chiclayo y Chimbote se abastecen de
 * otra forma. Un importador que "limpiara lo que no vino en el archivo" a secas
 * las vaciaría de un plumazo.
 *
 * El emparejamiento es por CÓDIGO DE BARRAS vía Catálogo (codbar → SKU de
 * Shopify → renglón con ese SKU), nunca por nombre: los títulos de Shopify y los
 * de Swayp no coinciden («SUPER HUMAN Ethiopian Black Seed Oil – Aceite…» contra
 * «ETHIOPIAN OIL») y emparejar por texto flojo inventa equivalencias.
 */
export function planearImportacion(
  ciudad: string,
  entradas: EntradaSwayp[],
  filasDeLaCiudad: FilaStock[],
  /**
   * codbar → SKUs de Shopify, desde `swayp_sku_map`.
   *
   * Es una LISTA y no un SKU porque el mapa se guarda por tienda y una
   * organización tiene varias (Aurela y Kenku venden el mismo frasco con
   * códigos de Shopify distintos). El stock, en cambio, es de la organización:
   * un solo renglón por ciudad y producto. Así que un código de barras puede
   * llegar por dos caminos y hay que probarlos todos antes de darlo por
   * huérfano.
   */
  skusPorCodbar: Map<string, string[]>,
  /**
   * SKU → la etiqueta con la que YA nombramos ese producto en cualquier otra
   * ciudad. Sirve para dar de alta lo que Swayp tiene y esta ciudad no tenía.
   *
   * La etiqueta se copia, no se inventa, y la diferencia importa: `product` es
   * lo que se cruza contra `shipments.product` para saber si hay stock. Usar el
   * nombre corto de Swayp («SUPER HUMAN FOCUS») crearía un renglón que no
   * matchea ninguna guía — un fantasma al revés, con stock que nunca se
   * encuentra. Medido: los tres SKU que faltaban en Trujillo tienen una única
   * etiqueta en el resto de ciudades, así que copiarla es determinista.
   */
  etiquetaPorSku: Map<string, string>,
): PlanImportacion {
  const porSku = new Map<string, FilaStock>();
  for (const f of filasDeLaCiudad) {
    const sku = (f.sku ?? "").trim().toUpperCase();
    if (sku) porSku.set(sku, f);
  }

  const ajustes: Ajuste[] = [];
  const altas: Alta[] = [];
  const huerfanos: Huerfano[] = [];
  const tocados = new Set<string>();
  let sinCambio = 0;
  let totalSwayp = 0;

  // Un renglón sin control de cantidad no se ajusta ni se pone en 0: no es un
  // conteo, es una declaración de que el producto existe en esa bodega. Se
  // marca como tocado para que el barrido final tampoco lo baje.
  let sinControl = 0;
  for (const f of filasDeLaCiudad) {
    if (f.unlimited) {
      tocados.add(f.id);
      sinControl++;
    }
  }

  for (const e of entradas) {
    totalSwayp += e.disponible;
    const skus = skusPorCodbar.get(e.codbar) ?? [];
    if (!skus.length) {
      huerfanos.push({ ...e, motivo: "sin_vinculo" });
      continue;
    }
    const fila = skus.map((s) => porSku.get(s.trim().toUpperCase())).find(Boolean);
    if (!fila) {
      // Swayp lo tiene en esa bodega y esta ciudad no lo tenía anotado. Si en
      // otra ciudad ya lo nombramos, se copia esa etiqueta y se da de alta: si
      // no, esas unidades se perderían. Medido en Trujillo: 34 unidades reales
      // (AURE008 y AURE014) caían en este caso.
      const conEtiqueta = skus
        .map((s) => ({ sku: s, product: etiquetaPorSku.get(s.trim().toUpperCase()) }))
        .find((x) => x.product);
      if (conEtiqueta?.product) {
        altas.push({
          sku: conEtiqueta.sku,
          product: conEtiqueta.product,
          cantidad: e.disponible,
          codbar: e.codbar,
        });
      } else {
        huerfanos.push({ ...e, motivo: "sin_etiqueta" });
      }
      continue;
    }
    if (fila.unlimited) continue; // ya contado en sinControl; el Excel no lo gobierna
    tocados.add(fila.id);
    if (fila.quantity === e.disponible) {
      sinCambio++;
      continue;
    }
    ajustes.push({
      id: fila.id,
      product: fila.product,
      sku: fila.sku,
      cantidadAnterior: fila.quantity,
      cantidadNueva: e.disponible,
      codbar: e.codbar,
    });
  }

  // Lo nuestro que el Excel no menciona: Swayp no lo tiene → 0.
  for (const f of filasDeLaCiudad) {
    if (tocados.has(f.id)) continue;
    if (f.quantity === 0) {
      sinCambio++;
      continue;
    }
    ajustes.push({
      id: f.id,
      product: f.product,
      sku: f.sku,
      cantidadAnterior: f.quantity,
      cantidadNueva: 0,
      codbar: "",
    });
  }

  return {
    ciudad,
    ajustes,
    altas,
    sinCambio,
    sinControl,
    huerfanos,
    totalSwayp,
    totalNuestro: filasDeLaCiudad.reduce((a, f) => a + f.quantity, 0),
  };
}

/**
 * Una línea que resume el plan para la persona que apretó el botón.
 *
 * Los huérfanos se nombran, no se cuentan: «3 sin ubicar» obliga a abrir la base
 * para saber cuáles. Se cortan en cinco para que el aviso siga siendo una línea.
 */
export function resumenDelPlan(plan: PlanImportacion): string {
  const partes: string[] = [];
  const bajan = plan.ajustes.filter((a) => a.cantidadNueva < a.cantidadAnterior).length;
  const suben = plan.ajustes.length - bajan;

  partes.push(
    plan.ajustes.length === 0 && plan.altas.length === 0
      ? `Stock de ${plan.ciudad} ya coincidía con Swayp`
      : `Stock de ${plan.ciudad}: ${plan.ajustes.length} ${plan.ajustes.length === 1 ? "renglón ajustado" : "renglones ajustados"} (${bajan} a la baja, ${suben} al alza)`,
  );
  if (plan.altas.length) {
    partes.push(`${plan.altas.length} ${plan.altas.length === 1 ? "producto nuevo" : "productos nuevos"} dados de alta`);
  }
  partes.push(`${plan.totalNuestro} → ${plan.totalSwayp} unidades`);
  if (plan.sinCambio) partes.push(`${plan.sinCambio} sin cambio`);
  if (plan.sinControl) partes.push(`${plan.sinControl} sin control de cantidad, no se tocan`);

  if (plan.huerfanos.length) {
    const nombres = plan.huerfanos.slice(0, 5).map((h) => h.codbar);
    const resto = plan.huerfanos.length - nombres.length;
    const sinVinculo = plan.huerfanos.filter((h) => h.motivo === "sin_vinculo").length;
    partes.push(
      `Sin ubicar: ${nombres.join(", ")}${resto > 0 ? ` y ${resto} más` : ""}` +
        (sinVinculo ? ` — ${sinVinculo} sin vincular en Catálogo de productos` : ""),
    );
  }
  return partes.join(". ") + ".";
}
