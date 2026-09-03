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
 * Declara: este anuncio vendió este producto, desde tal día.
 *
 * `validFrom` vacío = desde siempre, y es la primera declaración de un anuncio:
 * mientras nadie diga que cambió de producto, lo que se sabe de él vale para
 * todos sus leads. Poner fecha es lo que se hace cuando un creativo se reutiliza
 * —el del café que pasó a vender el gel de lengua—, y entonces cada lead toma la
 * que valía el día que entró en vez de que la nueva reescriba el pasado.
 *
 * El handle se normaliza igual que el que sale del link —minúsculas, sin
 * espacios— porque el objetivo entero es que los dos caigan en el MISMO balde.
 * Si se guardara «Beewax-Cera» y el link trajera «beewax-cera», la pantalla
 * mostraría dos productos donde hay uno.
 */
export async function declareAdProduct(input: {
  storeId: string;
  adId: string;
  handle: string;
  /** ISO. Vacío = desde siempre. */
  validFrom?: string | null;
  note?: string | null;
  adHeadline?: string | null;
}): Promise<AdProductActionResult> {
  const g = await guard(input.storeId);
  if ("error" in g) return { ok: false, error: g.error };

  const handle = input.handle.trim().toLowerCase();
  if (!handle) return { ok: false, error: "Elige un producto antes de declarar." };
  // El mismo alfabeto que acepta `leadProductHandle` al leer el link. Un handle
  // con un espacio o un acento no empataría nunca con el del link y el anuncio
  // quedaría en un balde propio, con cara de estar resuelto.
  if (!/^[a-z0-9._~-]+$/.test(handle)) {
    return { ok: false, error: "El handle solo admite letras sin tilde, números, punto, guion y guion bajo." };
  }

  const desde = (input.validFrom ?? "").trim();
  let validFrom = "-infinity";
  if (desde) {
    const t = Date.parse(desde);
    if (Number.isNaN(t)) return { ok: false, error: "La fecha «desde» no es válida." };
    // Una fecha futura declararía algo que todavía no pasa: ningún lead la
    // tomaría hoy y mañana empezaría a etiquetar sin que nadie se acuerde.
    if (t > Date.now()) return { ok: false, error: "La fecha «desde» no puede ser futura." };
    validFrom = new Date(t).toISOString();
  }

  // El titular vive en `ad_products`, que puede no tener fila si el anuncio es
  // nuevo. Se asegura antes para no perder el nombre con el que se reconoce.
  if (input.adHeadline) {
    await g.admin
      .from("ad_products")
      .upsert(
        { store_id: input.storeId, ad_id: input.adId, ad_headline: input.adHeadline },
        { onConflict: "store_id,ad_id" },
      );
  }

  const { error } = await g.admin.from("ad_product_declarations").upsert(
    {
      store_id: input.storeId,
      ad_id: input.adId,
      product_handle: handle,
      valid_from: validFrom,
      note: input.note?.trim() || null,
      declared_by: g.user.id,
      declared_at: new Date().toISOString(),
    },
    { onConflict: "store_id,ad_id,valid_from" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/leads/anuncios");
  revalidatePath("/dashboard/leads");
  return {
    ok: true,
    message: desde ? "Periodo declarado desde esa fecha." : "Anuncio declarado.",
  };
}

/**
 * Retira UNA declaración. Los leads que la tomaban caen al periodo anterior, y
 * si no hay ninguno, a «Sin producto».
 *
 * Borra la fila entera y no solo su handle: una declaración sin producto no
 * dice nada, y guardarla sería dejar un hueco con forma de dato.
 */
export async function removeAdDeclaration(input: {
  storeId: string;
  declarationId: string;
}): Promise<AdProductActionResult> {
  const g = await guard(input.storeId);
  if ("error" in g) return { ok: false, error: g.error };

  const { error } = await g.admin
    .from("ad_product_declarations")
    .delete()
    .eq("id", input.declarationId)
    .eq("store_id", input.storeId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/leads/anuncios");
  revalidatePath("/dashboard/leads");
  return { ok: true, message: "Declaración retirada." };
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
