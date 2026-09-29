// Sincronización de `fenix_stock` con el inventario de Swayp leído por API.
//
// La comparten el botón de Stock Swayp (una persona revisa el diff y aplica) y
// el cron `/api/cron/swayp-inventory` (corre solo, cada hora). Por eso vive
// aquí y no en las acciones del panel: todo lo que depende de quién llama
// —sesión, permiso, de dónde sale la credencial— lo resuelve quien llama; esto
// recibe la credencial, la organización y el cliente admin.
//
// El cruce es el de siempre (`planearImportacion`, reglas en el MOM, «De dónde
// sale el stock»). Lo que agrega el modo automático son las RETENCIONES: una
// ciudad cuya lectura la dejaría vaciada no se aplica sola, porque es mucho
// más probable un fallo de Swayp que una bodega que se quedó sin nada de un
// día para otro. Esa ciudad se informa y espera a una persona.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ciudadSinControl } from "@/lib/fenix";
import { recalcularElegibilidadFenix } from "@/lib/fenix-eligibility";
import { recordStockMovement } from "@/lib/fenix-ledger";
import {
  diagnoseInventoryAccess,
  fetchInventoryByCity,
  listInventoryWarehouses,
  SwaypInventoryError,
  type SwaypFilasSinCiudad,
  type SwaypInventoryCreds,
  type SwaypProbe,
  type SwaypWarehouse,
} from "@/lib/swayp-inventory-api";
import {
  planearImportacion,
  type EntradaSwayp,
  type FilaStock,
  type PlanImportacion,
} from "@/lib/swayp-inventario";
import { cargarMapaSwaypDeOrg } from "@/lib/swayp-sku-map";

/** El error de una llamada a Swayp en una línea, sin el token: status + cuerpo, o el mensaje. */
export function describirErrorSwayp(e: unknown): string {
  if (e instanceof SwaypInventoryError) return `HTTP ${e.status}${e.body ? ` — ${e.body.slice(0, 240)}` : ""}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// ── Lectura ──────────────────────────────────────────────────────────────────

export type LecturaSwayp =
  | {
      ok: true;
      bodegas: SwaypWarehouse[];
      porCiudad: Map<string, EntradaSwayp[]>;
      sinCiudad: SwaypFilasSinCiudad[];
      totalFilas: number;
      filasPorBodega: Record<string, number>;
      muestra: unknown[];
    }
  | { error: string; diagnostico?: SwaypProbe[] };

/** Bodegas + inventario de Swayp, repartido por ciudad. No escribe nada. */
export async function leerInventarioSwayp(creds: SwaypInventoryCreds): Promise<LecturaSwayp> {
  let bodegas: SwaypWarehouse[];
  try {
    bodegas = await listInventoryWarehouses(creds);
  } catch (e) {
    // Falla la de bodegas, que es el control: la credencial no sirve.
    return {
      error: `Swayp rechazó la credencial (${describirErrorSwayp(e)}): está vencida, es de otra sesión o no tiene permiso para el inventario.`,
      diagnostico: await diagnoseInventoryAccess(creds),
    };
  }
  try {
    const inv = await fetchInventoryByCity(creds, bodegas);
    return { ok: true, bodegas, ...inv };
  } catch (e) {
    // Bodegas pasó, así que la credencial es buena: se muestra el error REAL de
    // la lectura de inventario (status + cuerpo).
    return {
      error: `La credencial es válida (bodegas pasó), pero la lectura de inventario falló: ${describirErrorSwayp(e)}`,
      diagnostico: await diagnoseInventoryAccess(creds),
    };
  }
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlanDeCiudad {
  ciudad: string;
  plan: PlanImportacion;
  /** Renglones con control de cantidad y saldo > 0 antes de aplicar. */
  filasConStock: number;
}

/**
 * El plan de cada ciudad que trajo Swayp, con los mismos insumos que el
 * importador de Excel (`fenix_stock` y el mapa codbar→SKU de TODA la
 * organización: Aurela y Kenku comparten inventario en Swayp).
 */
export async function planesSwaypPorCiudad(
  admin: SupabaseClient,
  orgId: string,
  porCiudad: Map<string, EntradaSwayp[]>,
): Promise<PlanDeCiudad[]> {
  const skusPorCodbar = new Map<string, string[]>();
  for (const [sku, { codbar }] of await cargarMapaSwaypDeOrg(admin, orgId)) {
    const ya = skusPorCodbar.get(codbar.toUpperCase()) ?? [];
    if (!ya.includes(sku)) ya.push(sku);
    skusPorCodbar.set(codbar.toUpperCase(), ya);
  }
  const { data: todoElStock, error } = await admin
    .from("fenix_stock")
    .select("id,city,product,sku,quantity,unlimited")
    .eq("org_id", orgId);
  // Sin el stock actual el plan pondría TODO como alta; mejor no planear.
  if (error) throw new Error("No se pudo leer el stock Swayp de Kapta. Inténtalo de nuevo.");
  const filasPorCiudad = new Map<string, FilaStock[]>();
  const etiquetaPorSku = new Map<string, string>();
  for (const r of (todoElStock as (FilaStock & { city: string })[]) ?? []) {
    const lista = filasPorCiudad.get(r.city) ?? [];
    lista.push(r);
    filasPorCiudad.set(r.city, lista);
    const k = (r.sku ?? "").trim().toUpperCase();
    if (k && !etiquetaPorSku.has(k)) etiquetaPorSku.set(k, r.product);
  }

  const planes: PlanDeCiudad[] = [];
  for (const [ciudad, entradas] of porCiudad) {
    const sinControl = ciudadSinControl(ciudad);
    const filasStock = (filasPorCiudad.get(ciudad) ?? []).map((f) =>
      sinControl ? { ...f, unlimited: true } : f,
    );
    planes.push({
      ciudad,
      plan: planearImportacion(ciudad, entradas, filasStock, skusPorCodbar, etiquetaPorSku),
      filasConStock: filasStock.filter((f) => !f.unlimited && (f.quantity ?? 0) > 0).length,
    });
  }
  return planes.sort((a, b) => a.ciudad.localeCompare(b.ciudad));
}

/**
 * Por qué el sync AUTOMÁTICO no debe aplicar esta ciudad, o null si puede.
 * Pura. Dos casos, los dos con pinta de lectura rota más que de realidad:
 *   · Swayp no trae ni una unidad para la ciudad y nosotros sí tenemos.
 *   · Dejaría en 0 más de la mitad de los productos con stock (y al menos 5).
 * El botón manual no la usa: ahí una persona ya vio el diff antes de aplicar.
 */
export function motivoParaRetener(p: PlanDeCiudad): string | null {
  if (ciudadSinControl(p.ciudad)) return null;
  const { plan, filasConStock } = p;
  if (plan.totalSwayp === 0 && plan.totalNuestro > 0) {
    return `Swayp no trae unidades para esta ciudad y Kapta tiene ${plan.totalNuestro}: se vaciaría entera.`;
  }
  const aCero = plan.ajustes.filter((a) => a.cantidadNueva === 0 && a.cantidadAnterior > 0).length;
  if (aCero >= 5 && aCero * 2 > filasConStock) {
    return `Dejaría en 0 ${aCero} de ${filasConStock} productos con stock.`;
  }
  return null;
}

// ── Escritura ────────────────────────────────────────────────────────────────

/**
 * Escribe el plan de UNA ciudad: altas (renglón + `entrada` en el kardex) y
 * ajustes (`ajuste` en el kardex). Lo comparten el importador de Excel y el
 * sync por API, así que las dos fuentes dejan el mismo rastro. `origen` es lo
 * que se lee en la nota del kardex («Bodega Trujillo», «Swayp (API)»).
 * No recalcula la elegibilidad de las guías: eso lo hace quien llama, una vez.
 */
export async function aplicarPlanSwayp(
  admin: SupabaseClient,
  input: { orgId: string; userId: string | null; ciudad: string; plan: PlanImportacion; origen: string },
): Promise<{ altas: number; aplicados: number; fallidos: number }> {
  const { orgId, userId, ciudad, plan, origen } = input;
  // En una ciudad sin control (Lima) no hay saldo que mover: sólo altas.
  const sinControl = ciudadSinControl(ciudad);

  // Las altas primero: crear el renglón y dejar su entrada en el kardex, para
  // que el saldo nazca con historial igual que los demás.
  let altas = 0;
  for (const a of plan.altas) {
    const { data: creado, error } = await admin
      .from("fenix_stock")
      .upsert(
        {
          org_id: orgId,
          city: ciudad,
          product: a.product,
          sku: a.sku,
          quantity: 0,
          unlimited: sinControl,
          updated_by: userId,
        },
        { onConflict: "org_id,city,product" },
      )
      .select("id")
      .single();
    if (error || !creado) continue;
    altas++;
    // Sin control no hay saldo que arrancar: el alta ya dice todo.
    if (sinControl) continue;
    await recordStockMovement(admin, {
      orgId,
      stockId: (creado as { id: string }).id,
      city: ciudad,
      product: a.product,
      kind: "entrada",
      delta: a.cantidad,
      note: `Alta desde el inventario de ${origen} (${a.codbar})`,
      createdBy: userId,
    });
  }

  let aplicados = 0;
  for (const a of plan.ajustes) {
    const saldo = await recordStockMovement(admin, {
      orgId,
      stockId: a.id,
      city: ciudad,
      product: a.product,
      kind: "ajuste",
      delta: a.cantidadNueva - a.cantidadAnterior,
      note: a.codbar
        ? `Conteo de Swayp (${a.codbar}) importado de ${origen}`
        : `No figura en el inventario de ${origen}`,
      createdBy: userId,
    });
    if (saldo !== null) aplicados++;
  }

  return { altas, aplicados, fallidos: plan.ajustes.length - aplicados + (plan.altas.length - altas) };
}

// ── Sync completo ────────────────────────────────────────────────────────────

/** Lo que el sync escribió en una ciudad. */
export interface SyncCiudadResultado {
  ciudad: string;
  bajan: number;
  suben: number;
  /** De los que bajan, cuántos quedaron en 0. */
  aCero: number;
  altas: number;
  /** Códigos de Swayp sin vínculo en Catálogo: no se pudieron cargar. */
  sinVincular: string[];
  unidadesAntes: number;
  unidadesDespues: number;
  fallidos: number;
}

/** Una ciudad que el sync automático se negó a aplicar, y por qué. */
export interface CiudadRetenida {
  ciudad: string;
  motivo: string;
}

export type SyncResult =
  | {
      ok: true;
      ciudades: SyncCiudadResultado[];
      /** Sólo en automático: ciudades que esperan a que una persona las revise. */
      retenidas: CiudadRetenida[];
      /** Ciudades pedidas que no vinieron en la lectura: no se tocaron. */
      noVinieron: string[];
      /** Guías cuya elegibilidad se recalculó; null si el recálculo falló. */
      guias: number | null;
      errorGuias?: string;
    }
  | { error: string; diagnostico?: SwaypProbe[] };

/**
 * Lee Swayp, planea y aplica. `ciudades` acota a las pedidas (botón) o
 * "todas" (cron). En `source: "cron"` aplica las retenciones de
 * `motivoParaRetener`. Siempre recalcula la elegibilidad de las guías y deja
 * la corrida registrada en `swayp_inventory_sync_runs`, salga bien o mal.
 */
export async function sincronizarInventarioSwayp(
  admin: SupabaseClient,
  input: {
    creds: SwaypInventoryCreds;
    orgId: string;
    userId: string | null;
    ciudades: string[] | "todas";
    source: "cron" | "manual";
  },
): Promise<SyncResult> {
  const r = await sincronizar(admin, input);
  await registrarCorrida(admin, {
    orgId: input.orgId,
    source: input.source,
    userId: input.userId,
    resultado: r,
  });
  return r;
}

async function sincronizar(
  admin: SupabaseClient,
  input: {
    creds: SwaypInventoryCreds;
    orgId: string;
    userId: string | null;
    ciudades: string[] | "todas";
    source: "cron" | "manual";
  },
): Promise<SyncResult> {
  const pedidas =
    input.ciudades === "todas"
      ? null
      : new Set(input.ciudades.map((c) => c.trim().toLowerCase()).filter(Boolean));
  if (pedidas && !pedidas.size) return { error: "Elige al menos una ciudad para sincronizar." };

  const lectura = await leerInventarioSwayp(input.creds);
  if ("error" in lectura) return lectura;
  // Una lectura vacía es casi seguro un fallo de Swayp, no un inventario en
  // cero: aplicarla dejaría cada ciudad en 0.
  if (lectura.totalFilas === 0) {
    return { error: "Swayp devolvió el inventario vacío. No se aplicó nada." };
  }

  let planes: PlanDeCiudad[];
  try {
    planes = await planesSwaypPorCiudad(admin, input.orgId, lectura.porCiudad);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "No se pudo leer el stock Swayp." };
  }

  const ciudades: SyncCiudadResultado[] = [];
  const retenidas: CiudadRetenida[] = [];
  for (const p of planes) {
    if (pedidas && !pedidas.has(p.ciudad)) continue;
    const { ciudad, plan } = p;
    if (input.source === "cron") {
      const motivo = motivoParaRetener(p);
      if (motivo) {
        retenidas.push({ ciudad, motivo });
        continue;
      }
    }
    // Nada que escribir: no se ensucia el registro con una ciudad sin cambios.
    if (!plan.ajustes.length && !plan.altas.length && input.source === "cron") continue;
    const { fallidos } = await aplicarPlanSwayp(admin, {
      orgId: input.orgId,
      userId: input.userId,
      ciudad,
      plan,
      origen: input.source === "cron" ? "Swayp (API, automático)" : "Swayp (API)",
    });
    const bajan = plan.ajustes.filter((a) => a.cantidadNueva < a.cantidadAnterior);
    ciudades.push({
      ciudad,
      bajan: bajan.length,
      suben: plan.ajustes.length - bajan.length,
      aCero: bajan.filter((a) => a.cantidadNueva === 0).length,
      altas: plan.altas.length,
      sinVincular: plan.huerfanos.filter((h) => h.motivo === "sin_vinculo").map((h) => h.codbar),
      unidadesAntes: plan.totalNuestro,
      unidadesDespues: plan.totalSwayp,
      fallidos,
    });
  }

  // Elegibilidad de las guías pendientes de TODAS las tiendas de la
  // organización: el stock es de la organización, no de una tienda.
  let guias: number | null = null;
  let errorGuias: string | undefined;
  try {
    const { data: stores } = await admin.from("stores").select("id").eq("org_id", input.orgId);
    guias = await recalcularElegibilidadFenix(
      admin,
      input.orgId,
      ((stores as { id: string }[]) ?? []).map((s) => s.id),
    );
  } catch (e) {
    errorGuias = e instanceof Error ? e.message : "error desconocido";
    console.error("[swayp-inventory] recalcular elegibilidad:", e);
  }

  return {
    ok: true,
    ciudades,
    retenidas,
    noVinieron: pedidas ? [...pedidas].filter((c) => !lectura.porCiudad.has(c)) : [],
    guias,
    ...(errorGuias ? { errorGuias } : {}),
  };
}

async function registrarCorrida(
  admin: SupabaseClient,
  input: { orgId: string; source: "cron" | "manual"; userId: string | null; resultado: SyncResult },
): Promise<void> {
  const r = input.resultado;
  const fila =
    "error" in r
      ? { ok: false, error: r.error.slice(0, 1000), resumen: {} }
      : {
          ok: true,
          error: null,
          resumen: {
            ciudades: r.ciudades,
            retenidas: r.retenidas,
            noVinieron: r.noVinieron,
            guias: r.guias,
            errorGuias: r.errorGuias ?? null,
          },
        };
  // El registro no debe tumbar un sync que ya escribió: si falla, al log.
  const { error } = await admin.from("swayp_inventory_sync_runs").insert({
    org_id: input.orgId,
    source: input.source,
    created_by: input.userId,
    ...fila,
  });
  if (error) console.error("[swayp-inventory] registrar la corrida:", error.message);
}

// ── Credencial guardada ──────────────────────────────────────────────────────

/**
 * La credencial con la que corre el sync sin nadie delante, desde el entorno.
 * El token es el de integración de Swayp que Kapta ya usa para las guías
 * (`SWAYP_TOKEN`/`SWAYP_EMAIL`), salvo que haya uno exclusivo para inventario
 * (`SWAYP_INVENTORY_TOKEN`/`SWAYP_INVENTORY_EMAIL`). NO es el login del panel:
 * ese exige reCAPTCHA en cada inicio de sesión, justamente para impedir que un
 * programa inicie sesión solo, y no se automatiza.
 */
export function credencialInventarioDesdeEnv():
  | { ok: true; creds: SwaypInventoryCreds; orgId: string; tokenExclusivo: boolean }
  | { ok: false; faltan: string[] } {
  const e = process.env;
  const token = (e.SWAYP_INVENTORY_TOKEN || e.SWAYP_TOKEN || "").trim().replace(/^bearer\s+/i, "");
  const email = (e.SWAYP_INVENTORY_EMAIL || e.SWAYP_EMAIL || "").trim();
  const ruc = (e.SWAYP_INVENTORY_RUC || "").trim();
  const idCompany = (e.SWAYP_INVENTORY_COMPANY_ID || "").trim();
  const orgId = (e.SWAYP_INVENTORY_ORG_ID || "").trim();
  const faltan = [
    !token && "SWAYP_INVENTORY_TOKEN (o SWAYP_TOKEN)",
    !email && "SWAYP_INVENTORY_EMAIL (o SWAYP_EMAIL)",
    !ruc && "SWAYP_INVENTORY_RUC",
    !idCompany && "SWAYP_INVENTORY_COMPANY_ID",
    !orgId && "SWAYP_INVENTORY_ORG_ID",
  ].filter((v): v is string => !!v);
  if (faltan.length) return { ok: false, faltan };
  return {
    ok: true,
    creds: { token, email, user: ruc, idCompany, country: "PE" },
    orgId,
    tokenExclusivo: !!e.SWAYP_INVENTORY_TOKEN?.trim(),
  };
}
