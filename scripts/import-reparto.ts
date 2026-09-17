/**
 * Importa la historia de las hojas de motorizado del Excel «MASTER KEY 2.0»
 * a las hojas de Reparto propio de Liquidaciones 2.
 *
 *   pnpm tsx scripts/import-reparto.ts <org_id> <dir-con-matrices> [Roy Yhoni …]
 *
 * <dir-con-matrices> tiene un `matrix_<Hoja>.json` por hoja: la matriz de
 * celdas como texto (lo produce un volcado con openpyxl, porque el libro pesa
 * 30 MB y exceljs no lo aguanta en memoria). El lector y la escritura son los
 * mismos que usa la ruta de subida (/api/sheets/import), así que lo importado
 * desde aquí y lo que se suba después desde la pantalla siguen la misma regla.
 *
 * Requiere NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (lee .env).
 * Idempotente: re-importar actualiza lo importado y respeta lo editado a mano.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  }
}

async function main() {
  loadEnv();
  const [orgId, dir, ...only] = process.argv.slice(2);
  if (!orgId || !dir) {
    console.error("uso: tsx scripts/import-reparto.ts <org_id> <dir-con-matrices> [Roy Yhoni …]");
    process.exit(1);
  }
  const { createAdminSupabase } = await import("@/lib/db");
  const { ensureSheetsInitialized, seedSheetAliases } = await import("@/lib/sheets/access");
  const { importRepartoMatrix } = await import("@/lib/sheets/reparto-import-db");
  const { slugify } = await import("@/lib/sheets/templates");
  const admin = createAdminSupabase();

  const { data: stores } = await admin
    .from("stores")
    .select("id,org_id,name,shopify_domain,currency,timezone,status")
    .eq("org_id", orgId);
  if (!stores?.length) throw new Error(`La organización ${orgId} no tiene tiendas.`);
  const created = await ensureSheetsInitialized(orgId, stores, null);
  console.log(`hojas listas (creadas ahora: ${created.domains} dominios, ${created.sheets} hojas)`);

  const { data: sheets } = await admin
    .from("sheets")
    .select("id,org_id,domain_id,key,name,config,sheet_domains!inner(key)")
    .eq("org_id", orgId)
    .in("sheet_domains.key", ["reparto_propio", "courier_externo"]);
  const names = only.length ? only : ["Roy", "Yhoni", "DUGLAS", "Yukio", "Gera", "Marcos", "Alexis", "URPI"];
  for (const name of names) {
    const file = join(dir, `matrix_${name}.json`);
    if (!existsSync(file)) {
      console.warn(`- ${name}: no hay ${file}, se salta`);
      continue;
    }
    // Reparto propio (`reparto_<slug>`) o courier con cuaderno (`courier_<slug>`).
    const slug = slugify(name);
    const sheet = (sheets ?? []).find((s: { key: string }) => s.key === `reparto_${slug}` || s.key === `courier_${slug}`) as
      | { id: string; org_id: string; domain_id: string; key: string; name: string; sheet_domains: { key: string } | { key: string }[] }
      | undefined;
    if (!sheet) {
      console.warn(`- ${name}: no existe la hoja reparto_${slug} ni courier_${slug}, se salta`);
      continue;
    }
    const domainKey = Array.isArray(sheet.sheet_domains) ? sheet.sheet_domains[0]?.key : sheet.sheet_domains?.key;
    await seedSheetAliases(sheet.id, domainKey ?? "reparto_propio");
    const matrix = JSON.parse(readFileSync(file, "utf8")) as string[][];
    const summary = await importRepartoMatrix(
      admin,
      { id: sheet.id, org_id: sheet.org_id, domain_id: sheet.domain_id, key: sheet.key, name: sheet.name },
      matrix,
      { userId: null, filename: `MASTER KEY 2.0 · ${name}` },
    );
    console.log(
      `- ${name}: ${summary.rows} filas en ${summary.blocks} rutas · nuevas ${summary.inserted}, actualizadas ${summary.updated}, manuales respetadas ${summary.keptManual} · vinculadas ${summary.linked}, sin pedido en Kapta ${summary.unlinked} · a revisión ${JSON.stringify(summary.review)}`,
    );
    if (summary.unknownStatuses.length) {
      console.log(`  estados sin equivalente: ${summary.unknownStatuses.slice(0, 15).map(([a, n]) => `${a}×${n}`).join(", ")}`);
    }
    if (summary.unknownPayments.length) {
      console.log(`  métodos fuera de lista: ${summary.unknownPayments.slice(0, 10).map(([a, n]) => `${a}×${n}`).join(", ")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
