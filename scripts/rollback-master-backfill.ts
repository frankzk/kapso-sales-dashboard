/**
 * Deshace un lote de `scripts/apply-cuaderno-history-to-master.ts`.
 *
 *   pnpm tsx scripts/rollback-master-backfill.ts <batch_id> [--real]
 *
 * Borra los `order_events` que el lote insertó (los de la bitácora
 * `master_backfill_log`, 0173), recalcula el Master de esos pedidos y marca
 * `reverted_at`. Después compara el estado recalculado con `previous_general`
 * y avisa de los que no volvieron a lo mismo (porque otro evento posterior
 * los movió): esos se revisan a mano, no se fuerzan.
 */
import { existsSync, readFileSync } from "node:fs";

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
  const [batchId, ...flags] = process.argv.slice(2);
  const real = flags.includes("--real");
  if (!batchId) {
    console.error("uso: tsx scripts/rollback-master-backfill.ts <batch_id> [--real]");
    process.exit(1);
  }
  const { createAdminSupabase } = await import("@/lib/db");
  const { recomputeOrderMasterSafe } = await import("@/lib/order-master");
  const admin = createAdminSupabase();
  const { data: log, error } = await admin
    .from("master_backfill_log")
    .select("id,order_id,event_id,previous_general,reverted_at")
    .eq("batch_id", batchId);
  if (error) throw new Error(error.message);
  const entries = ((log ?? []) as { id: string; order_id: string; event_id: string | null; previous_general: string | null; reverted_at: string | null }[]).filter((e) => !e.reverted_at);
  console.log(`lote ${batchId}: ${entries.length} pedidos por revertir (${(log ?? []).length - entries.length} ya revertidos)`);
  if (!real) { console.log("ensayo: no se escribió nada. Añade --real para revertir."); return; }

  const eventIds = entries.map((e) => e.event_id).filter((id): id is string => Boolean(id));
  for (let i = 0; i < eventIds.length; i += 200) {
    const { error: delErr } = await admin.from("order_events").delete().in("id", eventIds.slice(i, i + 200));
    if (delErr) throw new Error(`borrando eventos: ${delErr.message}`);
  }
  const orderIds = entries.map((e) => e.order_id);
  for (let i = 0; i < orderIds.length; i += 200) await recomputeOrderMasterSafe(admin, orderIds.slice(i, i + 200));
  await admin.from("master_backfill_log").update({ reverted_at: new Date().toISOString() }).eq("batch_id", batchId).is("reverted_at", null);

  let same = 0;
  const differ: string[] = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data } = await admin.from("order_master").select("order_id,general_status").in("order_id", orderIds.slice(i, i + 200));
    const prev = new Map(entries.map((e) => [e.order_id, e.previous_general]));
    for (const m of (data ?? []) as { order_id: string; general_status: string }[]) {
      if (m.general_status === prev.get(m.order_id)) same += 1;
      else differ.push(`${m.order_id}: ahora ${m.general_status}, antes ${prev.get(m.order_id)}`);
    }
  }
  console.log(`revertidos: ${entries.length} · volvieron al estado anterior: ${same} · distintos (revisar a mano): ${differ.length}`);
  for (const d of differ.slice(0, 20)) console.log("  " + d);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
