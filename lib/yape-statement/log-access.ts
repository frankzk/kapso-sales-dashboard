import "server-only";

// Lee la bitácora del estado de cuenta de Yape para «Validar pagos › Estado de
// cuenta Yape» (MOM §16.2). Las tablas del estado de cuenta solo las lee el
// servidor (0224: nombres de quien paga), así que el alcance se aplica aquí:
// los reportes de una cuenta de cobro de las tiendas donde quien mira puede
// validar pagos, y de cada uno solo las conciliaciones de esas tiendas.

import { loadCollectionAccounts } from "@/lib/collection-accounts";
import { createAdminSupabase } from "@/lib/db";
import { paymentReviewBatches } from "@/lib/payment-review";
import { paymentValidationStores } from "@/lib/payment-review-access";
import {
  buildStatementLog,
  type StatementImportRow,
  type StatementLog,
  type StatementMatchRow,
  type StatementMovementRow,
  type StatementOrderRow,
  type StatementPaymentRow,
} from "@/lib/yape-statement/log";
import { statementAccountKey } from "@/lib/yape-statement/match";

export const STATEMENT_LOG_LIMIT = 30;

const IMPORT_COLS =
  "id,message_id,file_name,received_at,destination,period_from,period_to," +
  "movements,new_movements,unreadable,report,error,created_at,finished_at";

type ImportWithDestination = StatementImportRow & { destination: string | null };

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`bitácora del estado de cuenta: ${what} — ${error.message}`);
}

export async function getYapeStatementLog(): Promise<StatementLog | null> {
  const stores = await paymentValidationStores();
  if (!stores.length) return null;
  const storeIds = stores.map((store) => store.id);
  const admin = createAdminSupabase();

  const [accounts, importsRes] = await Promise.all([
    loadCollectionAccounts(admin, storeIds),
    admin
      .from("yape_statement_imports")
      .select(IMPORT_COLS)
      .order("created_at", { ascending: false })
      .limit(STATEMENT_LOG_LIMIT + 1),
  ]);
  fail("reportes", importsRes.error);
  const ours = new Set(
    [...accounts.values()]
      .flat()
      .flatMap((account) => [account.name, ...(account.aliases ?? [])])
      .map(statementAccountKey),
  );
  const fetched = (importsRes.data ?? []) as unknown as ImportWithDestination[];
  const truncated = fetched.length > STATEMENT_LOG_LIMIT;
  // Sin destino es un reporte que no se pudo leer: no trae a nadie, y ver que
  // llegó es justo lo que hace falta para entender por qué no validó nada.
  const imports = fetched
    .slice(0, STATEMENT_LOG_LIMIT)
    .filter((row) => !row.destination || ours.has(statementAccountKey(row.destination)));
  if (!imports.length) return buildStatementLog({ imports, matches: [], movements: [], payments: [], orders: [], truncated });

  const matches: StatementMatchRow[] = [];
  for (const batch of paymentReviewBatches(imports.map((row) => row.id))) {
    const { data, error } = await admin
      .from("yape_statement_matches")
      .select("import_id,payment_id,order_id,movement_key,rule")
      .in("import_id", batch)
      .in("store_id", storeIds)
      .eq("validated", true);
    fail("conciliaciones", error);
    matches.push(...((data ?? []) as StatementMatchRow[]));
  }

  const movements: StatementMovementRow[] = [];
  const payments: StatementPaymentRow[] = [];
  const orders: StatementOrderRow[] = [];
  const [movementBatches, paymentBatches, orderBatches] = [
    paymentReviewBatches([...new Set(matches.map((m) => m.movement_key))]),
    paymentReviewBatches([...new Set(matches.map((m) => m.payment_id))]),
    paymentReviewBatches([...new Set(matches.map((m) => m.order_id))]),
  ];
  await Promise.all([
    ...movementBatches.map(async (batch) => {
      const { data, error } = await admin
        .from("yape_statement_movements")
        .select("movement_key,origin,amount,occurred_at")
        .in("movement_key", batch);
      fail("movimientos", error);
      movements.push(...((data ?? []) as StatementMovementRow[]));
    }),
    ...paymentBatches.map(async (batch) => {
      const { data, error } = await admin
        .from("order_payments")
        .select("id,kind,validation_status")
        .in("id", batch);
      fail("pagos", error);
      payments.push(...((data ?? []) as StatementPaymentRow[]));
    }),
    ...orderBatches.map(async (batch) => {
      const { data, error } = await admin
        .from("order_master")
        .select("order_id,order_name,customer_name")
        .in("order_id", batch);
      fail("pedidos", error);
      orders.push(...((data ?? []) as StatementOrderRow[]));
    }),
  ]);

  return buildStatementLog({ imports, matches, movements, payments, orders, truncated });
}
