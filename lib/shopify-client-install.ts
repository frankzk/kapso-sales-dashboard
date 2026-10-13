/**
 * Lo que se hace al conectar (o reconectar) una tienda con la app de clientes:
 * webhooks de pedidos, borradores y desinstalación al handler por tienda, y la
 * primera sincronización. Lo usan el callback del OAuth (reinstalación) y la
 * acción que reclama una instalación pendiente. Todo es best-effort: un webhook
 * que falla no impide que la tienda quede conectada, y se devuelve el aviso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { runStoreSync } from "@/lib/ingest";
import { CLIENT_APP_WEBHOOK_TOPICS, registerOrderWebhooks } from "@/lib/shopify";

export async function finishClientStoreConnection(
  admin: SupabaseClient,
  input: { storeId: string; shop: string; token: string },
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const results = await registerOrderWebhooks({
      domain: input.shop,
      token: input.token,
      callbackUrl: `${env.siteUrl()}/api/webhooks/shopify/${input.storeId}`,
      extraTopics: CLIENT_APP_WEBHOOK_TOPICS,
    });
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      warnings.push(`Webhooks con problemas: ${failed.map((f) => `${f.topic}: ${f.error}`).join("; ")}`);
    }
  } catch (e) {
    warnings.push(`No se pudieron registrar los webhooks: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await runStoreSync(input.storeId, admin);
  } catch (e) {
    warnings.push(`Sincronización inicial incompleta: ${e instanceof Error ? e.message : String(e)}`);
  }
  return warnings;
}
