/**
 * Vuelve a leer los comprobantes que quedaron OBSERVADOS y rellena lo que falta.
 *
 * Uso local autorizado:
 *   pnpm exec tsx scripts/reprocess-vouchers.ts            # simulacro, no escribe
 *   pnpm exec tsx scripts/reprocess-vouchers.ts --escribir # aplica los cambios
 *
 * Lee primero `.env.production.local` y luego `.env.local`.
 *
 * El trabajo de verdad vive en `lib/voucher-reprocess.ts`, compartido con la
 * ruta de cron `/api/cron/reprocess-vouchers`. Aquí solo se imprime: si la
 * regla de qué se rellena viviera además en este fichero, tendríamos dos
 * versiones esperando a discrepar.
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

loadEnvFile(".env.production.local");
loadEnvFile(".env.local");

const WRITE = process.argv.includes("--escribir");

async function main() {
  const [{ createAdminSupabase }, { reprocessObservedVouchers }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/voucher-reprocess"),
  ]);

  const report = await reprocessObservedVouchers(createAdminSupabase(), { write: WRITE });

  console.log(`${report.candidates} comprobantes observados con imagen.${WRITE ? "" : "  (SIMULACRO)"}\n`);
  for (const note of report.notes) {
    console.log(`  ${note.paymentId}  ${note.kind}: ${note.detail}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Releídos:                        ${report.reread}/${report.candidates}`);
  console.log(`Visión falló (sin cambios):      ${report.visionFailed}`);
  console.log(`Nº de operación recuperado:      ${report.filledOperation}`);
  console.log(`Otros huecos rellenados:         ${report.filledOther}`);
  console.log(`Pasan a pendiente_revision:      ${report.unblocked}`);
  console.log(`Nº ya usado por otro pago:       ${report.clashes}`);
  console.log(`Siguen sin nº de operación:      ${report.stillNoOperation}`);
  console.log(`Receptor de ninguna cuenta:      ${report.recipientMismatch}   ← esto lo mira una persona`);

  console.log(`\nA qué cuenta de cobro llegó cada uno:`);
  const accounts = Object.entries(report.byAccount).sort((a, b) => b[1] - a[1]);
  if (!accounts.length) console.log("  (ninguna reconocida)");
  for (const [cuenta, n] of accounts) console.log(`  ${String(n).padStart(3)}  ${cuenta}`);

  console.log(`\nDistribución por rótulo (de qué banco vino cada comprobante):`);
  const labels = Object.entries(report.byLabel).sort((a, b) => b[1] - a[1]);
  if (!labels.length) console.log("  (ninguno legible)");
  for (const [label, n] of labels) console.log(`  ${String(n).padStart(3)}  ${label}`);

  if (!WRITE) {
    console.log(`\nSimulacro: no se escribió nada. Repite con --escribir para aplicarlo.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
