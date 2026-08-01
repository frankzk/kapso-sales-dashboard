/**
 * Recalcula las macroetapas MOM de todos los pedidos existentes.
 *
 * Uso local autorizado:
 *   pnpm exec tsx scripts/backfill-mom.ts
 *
 * Lee primero `.env.production.local` y luego `.env.local`. Es idempotente:
 * solo reconstruye `order_master` desde las fuentes operativas existentes.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key]) continue;
    let value = (rawValue ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(".env.mom.local");
loadEnvFile(".env.production.local");
loadEnvFile(".env.local");

async function main() {
  const [{ createAdminSupabase }, { recomputeOrderMaster }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/order-master"),
  ]);
  const admin = createAdminSupabase();
  const pageSize = 250;
  let from = 0;
  let written = 0;

  for (;;) {
    const { data, error } = await admin
      .from("orders")
      .select("id")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`No se pudieron listar pedidos: ${error.message}`);

    const ids = (data ?? []).map((row: { id: string }) => row.id);
    if (!ids.length) break;

    const result = await recomputeOrderMaster(admin, ids);
    written += result.written;
    from += ids.length;
    console.log(`MOM: ${written} pedidos recalculados`);
    if (ids.length < pageSize) break;
  }

  console.log(`MOM completo: ${written} pedidos recalculados`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
