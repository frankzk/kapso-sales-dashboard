import "server-only";

// La llamada a Claude Haiku 5.5 para las respuestas de Leads → Redes (MOM
// §25.4). Las reglas, el texto que se le da y el filtro viven en
// lib/social-ai.ts (puro). Nunca lanza: ante cualquier fallo devuelve null y
// quien llama cae a los textos fijos de lib/social-auto.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { buildSystemPrompt, buildUserPrompt, parseAiReply, SOCIAL_AI_MODEL, SOCIAL_AI_SCHEMA, type CatalogItem, type SocialAiInput, type SocialAiReply } from "@/lib/social-ai";
import { loadStoreOrderPlatform, wooSaleClient } from "@/lib/woocommerce-orders";
import { wooGetPage } from "@/lib/woocommerce";
import { withWooAuthFallback } from "@/lib/woocommerce-intake";

const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 25_000;
const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map<string, { at: number; items: CatalogItem[] }>();

export function socialAiConfigured(): boolean {
  return Boolean(env.anthropicApiKey());
}

/** El modelo: Claude Haiku 5.5 (el más económico); se cambia con SOCIAL_AI_MODEL sin tocar código. */
function model(): string {
  return process.env.SOCIAL_AI_MODEL?.trim() || SOCIAL_AI_MODEL;
}

/** El catálogo publicado de la tienda con su precio (WooCommerce, en vivo; 10 minutos en memoria). */
export async function storeCatalog(admin: SupabaseClient, storeId: string): Promise<CatalogItem[]> {
  const hit = catalogCache.get(storeId);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.items;
  let items: CatalogItem[] = [];
  try {
    const platform = await loadStoreOrderPlatform(admin, storeId);
    if (platform.ok && platform.platform === "woocommerce") {
      const client = wooSaleClient(platform.creds, { timeoutMs: 8_000 });
      const result = await withWooAuthFallback(client, (opts) =>
        wooGetPage<{ name: string; price: string; status: string }>(opts, "/products", { status: "publish", per_page: 60, _fields: "name,price,status" }));
      items = result.value.items
        .filter((p) => p.status === "publish" && p.name)
        .map((p) => {
          const price = Number(p.price);
          return { name: p.name.trim(), price: Number.isFinite(price) && price > 0 ? price : null };
        });
    }
  } catch (e) {
    // Sin catálogo la IA no da precios: invita a WhatsApp.
    console.warn(`[social-ai] catálogo no disponible (tienda ${storeId}): ${e instanceof Error ? e.message : String(e)}`);
  }
  console.info(`[social-ai] catálogo tienda ${storeId}: ${items.length} productos`);
  catalogCache.set(storeId, { at: Date.now(), items });
  return items;
}

function extractText(json: unknown): string {
  const content = (json as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/** Pide la respuesta al modelo. Null si no hay clave, falla, se niega o no devuelve el formato. */
export async function generateSocialAiReply(input: SocialAiInput, fetchImpl: typeof fetch = fetch): Promise<SocialAiReply | null> {
  const apiKey = env.anthropicApiKey();
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const send = (structured: boolean) =>
    fetchImpl(`${env.anthropicApiBase()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: model(),
        max_tokens: 2048,
        output_config: { effort: "low", ...(structured ? { format: { type: "json_schema", schema: SOCIAL_AI_SCHEMA } } : {}) },
        system: buildSystemPrompt(input.storeName),
        messages: [{
          role: "user",
          content: `${buildUserPrompt(input)}${structured ? "" : '\n\nDevuelve solo un JSON: {"omitir": boolean, "publico": string, "privado": string}.'}`,
        }],
      }),
      signal: controller.signal,
    });
  try {
    let res = await send(true);
    // Un modelo configurado sin salida estructurada: se repite pidiendo el JSON en el texto.
    if (res.status === 400) {
      const body = await res.clone().text().catch(() => "");
      if (/format|json_schema|output_config/i.test(body)) res = await send(false);
    }
    if (!res.ok) return null;
    const json = await res.json();
    if ((json as { stop_reason?: string }).stop_reason === "refusal") return null;
    return parseAiReply(extractText(json), input.kind, input.whatsapp);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
