"use server";

// Declarar qué producto vende un anuncio, y retirar esa declaración.
//
// La regla que estas dos acciones sostienen: una sugerencia del histórico NO
// etiqueta leads. Solo una firma lo hace. Ver `lib/ad-products.ts`.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeAdSuggestions } from "@/lib/ad-products-access";

export interface AdProductActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function guard(storeId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const perms = await getMasterPermissions();
  if (!perms.can("leads.map_ads")) {
    return { error: "Tu rol no permite declarar el producto de un anuncio." as const };
  }
  const stores = await getAccessibleStores();
  if (!stores.some((s) => s.id === storeId)) {
    return { error: "Tienda inválida o sin acceso." as const };
  }
  return { user, admin: createAdminSupabase() };
}

/**
 * Firma: este anuncio vende este producto.
 *
 * El handle se normaliza igual que el que sale del link —minúsculas, sin
 * espacios— porque el objetivo entero es que los dos caigan en el MISMO balde.
 * Si se guardara «Beewax-Cera» y el link trajera «beewax-cera», la pantalla
 * mostraría dos productos donde hay uno, que es el problema que vinimos a
 * resolver.
 */
export async function confirmAdProduct(input: {
  storeId: string;
  adId: string;
  handle: string;
  adHeadline?: string | null;
}): Promise<AdProductActionResult> {
  const g = await guard(input.storeId);
  if ("error" in g) return { ok: false, error: g.error };

  const handle = input.handle.trim().toLowerCase();
  if (!handle) return { ok: false, error: "Elige un producto antes de confirmar." };
  // El mismo alfabeto que acepta `leadProductHandle` al leer el link. Un handle
  // con un espacio o un acento no empataría nunca con el del link y el anuncio
  // quedaría en un balde propio, con cara de estar resuelto.
  if (!/^[a-z0-9._~-]+$/.test(handle)) {
    return { ok: false, error: "El handle solo admite letras sin tilde, números, punto, guion y guion bajo." };
  }

  const { error } = await g.admin.from("ad_products").upsert(
    {
      store_id: input.storeId,
      ad_id: input.adId,
      product_handle: handle,
      ad_headline: input.adHeadline ?? null,
      confirmed_by: g.user.id,
      confirmed_at: new Date().toISOString(),
    },
    { onConflict: "store_id,ad_id" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/leads/anuncios");
  revalidatePath("/dashboard/leads");
  return { ok: true, message: "Anuncio declarado." };
}

/**
 * Retira la declaración: sus leads vuelven a «Sin producto».
 *
 * Borra la firma, no la fila: la sugerencia y el titular siguen ahí para
 * volver a decidir. Y NO borra el handle a la vez que la firma en dos pasos —
 * el CHECK de la base rechaza una fila firmada sin handle, así que los dos
 * campos se limpian juntos o la escritura falla entera, que es lo correcto.
 */
export async function clearAdProduct(input: {
  storeId: string;
  adId: string;
}): Promise<AdProductActionResult> {
  const g = await guard(input.storeId);
  if ("error" in g) return { ok: false, error: g.error };

  const { error } = await g.admin
    .from("ad_products")
    .update({ product_handle: null, confirmed_at: null, confirmed_by: null })
    .eq("store_id", input.storeId)
    .eq("ad_id", input.adId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/leads/anuncios");
  revalidatePath("/dashboard/leads");
  return { ok: true, message: "Declaración retirada. Sus leads vuelven a «Sin producto»." };
}

/**
 * Recalcula las sugerencias del histórico para las tiendas accesibles.
 *
 * A mano y no en un cron: es una lectura pesada —todos los leads con anuncio
 * cruzados contra todos sus pedidos— y lo que produce no se aplica solo. Sirve
 * cuando entran anuncios nuevos y alguien va a sentarse a declararlos.
 */
export async function refreshAdSuggestions(): Promise<AdProductActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "No autenticado." };
  const perms = await getMasterPermissions();
  if (!perms.can("leads.map_ads")) {
    return { ok: false, error: "Tu rol no permite declarar el producto de un anuncio." };
  }
  const stores = await getAccessibleStores();
  const { anuncios } = await recomputeAdSuggestions(
    stores.map((s) => s.id),
    createAdminSupabase(),
  );
  revalidatePath("/dashboard/leads/anuncios");
  return { ok: true, message: `Sugerencias recalculadas para ${anuncios} anuncio(s).` };
}
