// Lecturas y escrituras del mapa anuncio → producto, con RLS.
//
// Ver `lib/ad-products.ts` para la regla: una fila solo etiqueta leads cuando
// alguien la firmó. Aquí solo se lee y se escribe; la frontera vive allá, pura
// y probada.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import {
  mapaAnuncioProducto,
  sugerenciaDeAnuncio,
  type AdProductRow,
  type CompraDeAnuncio,
} from "@/lib/ad-products";
import { canonicalProductHandles, leadProductHandle } from "@/lib/leads";

/** Lo mínimo que estas funciones piden de un cliente Supabase. */
type SupabaseLike = ReturnType<typeof createAdminSupabase>;

const AD_PRODUCT_COLUMNS =
  "ad_id,store_id,product_handle,ad_headline,suggested_label,evidence_pct,evidence_sample,confirmed_at,confirmed_by,updated_at";

/**
 * El mapa que usa la cola: `tienda::anuncio → handle`, SOLO lo declarado.
 *
 * Se pide por los `ad_id` que la cola tiene en pantalla, no la tabla entera:
 * son 88 anuncios hoy pero la tabla crece con cada campaña, y la cola no
 * necesita los que no aparecen.
 */
export async function getAdProductMap(
  storeIds: string[],
  adIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(adIds.filter((id): id is string => !!id))];
  if (!storeIds.length || !ids.length) return new Map();
  const sb = await createServerSupabase();
  const rows: AdProductRow[] = [];
  for (const batch of chunk(ids, 200)) {
    const { data } = await sb
      .from("ad_products")
      .select(AD_PRODUCT_COLUMNS)
      .in("store_id", storeIds)
      .in("ad_id", batch)
      .not("confirmed_at", "is", null);
    rows.push(...((data ?? []) as unknown as AdProductRow[]));
  }
  return mapaAnuncioProducto(rows);
}

/**
 * Todo lo que la pantalla de asignación necesita: los anuncios con leads en la
 * cola, su titular, cuántos leads dependen de cada uno y lo que ya se declaró.
 *
 * Ordena por VOLUMEN de leads pendientes. Es lo que decide por dónde empezar:
 * declarar el anuncio de la caspa desatasca 460 leads de una firma; declarar
 * uno de 2 leads no cambia nada.
 */
export interface AdProductAsignable extends AdProductRow {
  leads: number;
}

export async function getAdsParaAsignar(storeIds: string[]): Promise<AdProductAsignable[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();

  // Los anuncios que hoy tienen leads sin llamar. Es el universo que importa:
  // un anuncio apagado hace tres meses no tiene a nadie esperando llamada.
  const { data: leadRows } = await sb
    .from("leads")
    .select("store_id,ad_id,ad_headline")
    .in("store_id", storeIds)
    .eq("status", "nuevo")
    .not("ad_id", "is", null)
    .limit(5000);

  const porAnuncio = new Map<string, { store_id: string; ad_id: string; headline: string | null; leads: number }>();
  for (const row of (leadRows ?? []) as {
    store_id: string;
    ad_id: string | null;
    ad_headline: string | null;
  }[]) {
    if (!row.ad_id) continue;
    const key = `${row.store_id}::${row.ad_id}`;
    const prev = porAnuncio.get(key);
    if (prev) prev.leads += 1;
    else
      porAnuncio.set(key, {
        store_id: row.store_id,
        ad_id: row.ad_id,
        headline: row.ad_headline,
        leads: 1,
      });
  }
  if (!porAnuncio.size) return [];

  const declarados = new Map<string, AdProductRow>();
  const ids = [...new Set([...porAnuncio.values()].map((a) => a.ad_id))];
  for (const batch of chunk(ids, 200)) {
    const { data } = await sb
      .from("ad_products")
      .select(AD_PRODUCT_COLUMNS)
      .in("store_id", storeIds)
      .in("ad_id", batch);
    for (const row of (data ?? []) as unknown as AdProductRow[]) {
      declarados.set(`${row.store_id}::${row.ad_id}`, row);
    }
  }

  return [...porAnuncio.entries()]
    .map(([key, anuncio]) => {
      const fila = declarados.get(key);
      return {
        store_id: anuncio.store_id,
        ad_id: anuncio.ad_id,
        // El titular de la tabla puede estar viejo; el de la cola es el último
        // que llegó. Gana el nuevo, que es el que la persona reconoce.
        ad_headline: anuncio.headline ?? fila?.ad_headline ?? null,
        product_handle: fila?.product_handle ?? null,
        suggested_label: fila?.suggested_label ?? null,
        evidence_pct: fila?.evidence_pct ?? null,
        evidence_sample: fila?.evidence_sample ?? null,
        confirmed_at: fila?.confirmed_at ?? null,
        confirmed_by: fila?.confirmed_by ?? null,
        leads: anuncio.leads,
      } satisfies AdProductAsignable;
    })
    .sort((a, b) => b.leads - a.leads || a.ad_id.localeCompare(b.ad_id));
}

/**
 * Los handles que ya se han visto en links, para elegir de una lista en vez de
 * teclearlos.
 *
 * Es lo que garantiza que el anuncio caiga en el MISMO balde que la ficha:
 * teclear «beewax-cera-de-abeja» cuando el link dice
 * «beewax-cera-de-abeja-natural» crea un producto nuevo con cara de resuelto.
 */
export async function getHandlesConocidos(storeIds: string[]): Promise<string[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("leads")
    .select("first_inbound_text")
    .in("store_id", storeIds)
    .ilike("first_inbound_text", "%/products/%")
    .order("last_interaction_at", { ascending: false })
    .limit(3000);
  const handles = new Set<string>();
  for (const row of (data ?? []) as { first_inbound_text: string | null }[]) {
    const h = leadProductHandle(row.first_inbound_text);
    if (h) handles.add(h);
  }
  // El plegado de recortes también aquí: ofrecer «…-60-softge» en la lista
  // sería invitar a firmar el handle cortado.
  const canon = canonicalProductHandles(handles);
  return [...new Set([...handles].map((h) => canon.get(h) ?? h))].sort();
}

/**
 * Recalcula las SUGERENCIAS: qué compraron históricamente los leads de cada
 * anuncio.
 *
 * No toca `product_handle` ni `confirmed_at`. Una sugerencia nueva no puede
 * mover una declaración firmada — quien firmó vio la evidencia de entonces y
 * decidió; recalcular no le quita la firma por la espalda.
 */
export async function recomputeAdSuggestions(
  storeIds: string[],
  admin: SupabaseLike,
): Promise<{ anuncios: number }> {
  if (!storeIds.length) return { anuncios: 0 };

  const { data: leadRows } = await admin
    .from("leads")
    .select("store_id,ad_id,phone,ad_headline")
    .in("store_id", storeIds)
    .not("ad_id", "is", null)
    .not("phone", "is", null)
    .limit(20000);
  const leads = (leadRows ?? []) as {
    store_id: string;
    ad_id: string;
    phone: string;
    ad_headline: string | null;
  }[];
  if (!leads.length) return { anuncios: 0 };

  // Teléfono → los anuncios por los que llegó. Un mismo número puede haber
  // entrado por dos anuncios distintos; su compra cuenta para los dos, que es
  // lo honesto cuando no se sabe cuál de los dos la provocó.
  const porTelefono = new Map<string, Set<string>>();
  const headlines = new Map<string, string | null>();
  const soloDigitos = (v: string) => v.replace(/\D/g, "");
  for (const l of leads) {
    const key = `${l.store_id}::${soloDigitos(l.phone)}`;
    const set = porTelefono.get(key) ?? new Set<string>();
    set.add(`${l.store_id}::${l.ad_id}`);
    porTelefono.set(key, set);
    headlines.set(`${l.store_id}::${l.ad_id}`, l.ad_headline);
  }

  const compras = new Map<string, CompraDeAnuncio[]>();
  const telefonos = [...new Set(leads.map((l) => l.phone))];
  for (const batch of chunk(telefonos, 200)) {
    const { data } = await admin
      .from("orders")
      .select("store_id,customer_phone,line_items")
      .in("store_id", storeIds)
      .in("customer_phone", batch);
    for (const row of (data ?? []) as {
      store_id: string;
      customer_phone: string | null;
      line_items: unknown;
    }[]) {
      const anuncios = porTelefono.get(`${row.store_id}::${soloDigitos(row.customer_phone ?? "")}`);
      if (!anuncios) continue;
      const items = Array.isArray(row.line_items) ? row.line_items : [];
      for (const item of items as Record<string, unknown>[]) {
        const title = typeof item?.title === "string" ? item.title : "";
        if (!title.trim()) continue;
        for (const anuncio of anuncios) {
          const lista = compras.get(anuncio) ?? [];
          lista.push({ title });
          compras.set(anuncio, lista);
        }
      }
    }
  }

  const filas: Record<string, unknown>[] = [];
  for (const [anuncio, lista] of compras) {
    const sugerencia = sugerenciaDeAnuncio(lista);
    if (!sugerencia) continue;
    const [store_id, ad_id] = anuncio.split("::");
    filas.push({
      store_id,
      ad_id,
      ad_headline: headlines.get(anuncio) ?? null,
      suggested_label: sugerencia.label,
      evidence_pct: sugerencia.pct,
      evidence_sample: sugerencia.sample,
    });
  }
  for (const batch of chunk(filas, 200)) {
    await admin.from("ad_products").upsert(batch, { onConflict: "store_id,ad_id" });
  }
  return { anuncios: filas.length };
}
