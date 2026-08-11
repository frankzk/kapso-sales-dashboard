/**
 * Repara el desvío de la guía AUR5X122767, que quedó colgada de #KP120351.
 *
 * Uso local autorizado:
 *   pnpm exec tsx scripts/reparar-guia-aur5x122767.ts           # solo diagnostica
 *   pnpm exec tsx scripts/reparar-guia-aur5x122767.ts --apply   # escribe
 *
 * QUÉ PASÓ. El 17-07-2026 la conciliación promovió por teléfono: la fila del
 * reporte traía la guía AUR5X122767 del pedido de julio, y la única guía
 * provisional viva con ese teléfono era la del pedido de junio. La promoción
 * escribe UNA sola columna —`guide_code`—, así que el daño es exactamente ese:
 * la guía de #KP120351 dejó de llamarse por su código provisional y pasó a
 * llamarse como el paquete de #KP122767.
 *
 * POR QUÉ ESO ES REPARABLE. `external_order_number` no se tocó, y sigue
 * guardando el orderNumber real que Aliclik le dio a la guía de #KP120351.
 * Devolverle ese código a la fila deshace la promoción sin inventar nada.
 *
 * Y POR QUÉ NO HACE FALTA CREAR NADA PARA #KP122767. Al liberarse el código
 * AUR5X122767, deja de existir como guía en la base; la siguiente importación
 * del reporte lo ingesta como una guía nueva y lo casa con su pedido por
 * nombre, que es el camino normal. Inventar aquí la fila sería adivinar su
 * estado, su dirección y su importe.
 *
 * LO QUE ESTE SCRIPT NO ARREGLA, y hay que mirar a mano: desde el 17-07 cada
 * importación del reporte encontró la fila por `guide_code` y le fundió encima
 * los datos del OTRO paquete —estado de entrega, dirección, distrito, intentos,
 * importe a cobrar—. Devolver el código no devuelve esos campos. El script
 * imprime los que hay que revisar. Si el estado quedó terminal (entregado o
 * anulado) la precedencia monotónica impedirá que el barrido lo corrija solo.
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

/** El código impreso que se desvió. */
const GUIDE = "AUR5X122767";
/** El pedido que se quedó con la guía ajena. */
const WRONG_ORDER = "#KP120351";
/** El pedido dueño del paquete. */
const RIGHT_ORDER = "#KP122767";

/** Campos que la importación del otro paquete pudo haber pisado. */
const CONTAMINABLE = [
  "delivery_status",
  "status_category",
  "reported_status",
  "district",
  "province",
  "city",
  "region",
  "delivery_address",
  "aliclik_attempts",
  "reported_collect_amount",
  "dispatched_at",
  "returned_at",
  "last_report_at",
] as const;

async function main() {
  const apply = process.argv.includes("--apply");
  const { createAdminSupabase } = await import("@/lib/db");
  const { isProvisionalGuideCode } = await import("@/lib/aliclik-reconcile");
  const admin = createAdminSupabase();

  const { data: orders, error: ordersError } = await admin
    .from("orders")
    .select("id,name,customer_phone,created_at")
    .in("name", [WRONG_ORDER, RIGHT_ORDER]);
  if (ordersError) throw ordersError;
  const byName = new Map((orders ?? []).map((o: { name: string }) => [o.name, o]));
  const wrong = byName.get(WRONG_ORDER) as { id: string; name: string } | undefined;
  const right = byName.get(RIGHT_ORDER) as { id: string; name: string } | undefined;

  const { data: shipments, error: shipError } = await admin
    .from("shipments")
    .select(
      `id,guide_code,external_order_number,order_id,order_name,store_id,matched,match_method,` +
        `customer_phone,source,created_via,created_at,updated_at,api_report_at,${CONTAMINABLE.join(",")}`,
    )
    .eq("courier", "aliclik")
    .eq("guide_code", GUIDE);
  if (shipError) throw shipError;
  const ship = (shipments ?? [])[0] as Record<string, unknown> | undefined;

  console.log("=== Diagnóstico ===");
  console.log(`${WRONG_ORDER}:`, wrong ? wrong.id : "NO ESTÁ EN EL MASTER");
  console.log(`${RIGHT_ORDER}:`, right ? right.id : "NO ESTÁ EN EL MASTER");
  console.log(`guía ${GUIDE}:`, ship ? JSON.stringify(ship, null, 2) : "NO EXISTE");

  // --- Verificación de la forma esperada. En la duda no se toca nada. ---
  const stop = (motivo: string) => {
    console.log(`\nNO SE ESCRIBE: ${motivo}`);
    console.log("La forma real no es la que este script sabe reparar. Revisar a mano.");
  };

  if (!ship) return stop(`no hay ninguna guía ${GUIDE}`);
  if (!wrong || !right) return stop("falta uno de los dos pedidos en el Master");
  if (ship.order_id === right.id) {
    console.log(`\nNADA QUE HACER: ${GUIDE} ya apunta a ${RIGHT_ORDER}.`);
    return;
  }
  if (ship.order_id !== wrong.id) {
    return stop(`la guía no cuelga de ${WRONG_ORDER}, sino de order_id=${String(ship.order_id)}`);
  }

  const provisional = (ship.external_order_number ?? null) as string | null;
  if (!provisional) {
    return stop(
      "la guía no conserva su external_order_number, así que no hay código provisional " +
        "al que volver. Sin él no se puede deshacer la promoción sin inventar un código.",
    );
  }
  if (!isProvisionalGuideCode(provisional)) {
    return stop(`external_order_number "${provisional}" no es un código provisional ALC…`);
  }

  // El código al que volvemos no puede estar ya ocupado por otra fila.
  const { data: collision, error: collisionError } = await admin
    .from("shipments")
    .select("id")
    .eq("courier", "aliclik")
    .eq("guide_code", provisional);
  if (collisionError) throw collisionError;
  if ((collision ?? []).length) {
    return stop(`el código provisional ${provisional} ya lo lleva otra guía`);
  }

  console.log("\n=== Reparación ===");
  console.log(`${ship.id}: guide_code ${GUIDE} → ${provisional}`);
  console.log(`  ${WRONG_ORDER} recupera su guía propia, con el código que Aliclik le dio.`);
  console.log(`  ${GUIDE} queda libre y el próximo reporte lo ingesta para ${RIGHT_ORDER}.`);

  if (!apply) {
    console.log("\n(ensayo — volver a correr con --apply para escribir)");
    return;
  }

  const { data: updated, error: updateError } = await admin
    .from("shipments")
    .update({ guide_code: provisional })
    .eq("id", ship.id as string)
    // Guarda contra una carrera: si algo lo cambió mientras diagnosticábamos,
    // este UPDATE no encuentra fila y no pisa nada.
    .eq("guide_code", GUIDE)
    .select("id");
  if (updateError) throw updateError;
  if (!(updated ?? []).length) {
    console.log("\nNO SE ESCRIBIÓ: la fila cambió durante el diagnóstico. Volver a correr.");
    return;
  }
  console.log("\nHECHO.");

  console.log("\n=== Revisar a mano en la guía reparada ===");
  console.log(
    `Estos campos venían del paquete de ${RIGHT_ORDER} y siguen escritos en la guía de ` +
      `${WRONG_ORDER}. Contrastarlos contra el panel de Aliclik para ${provisional}:`,
  );
  for (const field of CONTAMINABLE) console.log(`  ${field}: ${JSON.stringify(ship[field])}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
