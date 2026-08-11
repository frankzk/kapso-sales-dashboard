/**
 * Busca guías promovidas al pedido equivocado, como AUR5X122767 lo estuvo.
 *
 * Uso local autorizado (SOLO LEE, no escribe nada):
 *   pnpm exec tsx scripts/auditar-promociones-por-telefono.ts
 *
 * QUÉ BUSCA. Una guía creada por API nace con código provisional `ALC…` y la
 * conciliación le pone después el impreso `AUR5X…` del reporte. La promoción
 * escribe UNA sola columna, `guide_code`, así que una guía promovida se
 * reconoce sin ambigüedad: lleva un `AUR5X…` en `guide_code` y conserva el
 * `ALC…` en `external_order_number`. Esa es la población en riesgo.
 *
 * CÓMO SE DISTINGUE LA MAL PROMOVIDA. El código impreso termina en el número
 * del pedido Shopify —la misma regla que ya usa `isCompatibleManualPortalGuide`
 * para autorizar una guía del portal—. Si el sufijo del código no es el número
 * del pedido al que cuelga, la guía está en el pedido equivocado.
 *
 * ESA REGLA NO SE DA POR BUENA: se mide. El script imprime primero cuántas de
 * todas las promovidas SÍ cumplen el sufijo. Si casi todas cumplen, un
 * incumplimiento señala de verdad; si no cumple ni la mitad, la convención no
 * existe y el hallazgo no vale —y el script lo dice en vez de acusar a cientos
 * de filas por una suposición mía.
 *
 * LA CONFIRMACIÓN. Para cada sospechosa se busca el pedido cuyo número SÍ es el
 * sufijo del código. Si ese pedido existe y además comparte teléfono con el
 * pedido al que la guía cuelga hoy, es el caso completo: dos pedidos del mismo
 * cliente y la guía en el que no era. Eso ya no es indicio, es el mecanismo.
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

const PAGE = 500;
const TERMINAL = new Set(["entregado", "anulado", "transferido"]);

interface Ship {
  id: string;
  guide_code: string;
  external_order_number: string | null;
  order_id: string;
  delivery_status: string | null;
  created_at: string | null;
  updated_at: string | null;
}
interface Order {
  id: string;
  name: string;
  customer_phone: string | null;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const { createAdminSupabase } = await import("@/lib/db");
  const { isProvisionalGuideCode } = await import("@/lib/aliclik-reconcile");
  const { isCompatibleManualPortalGuide } = await import("@/lib/aliclik-existing-guide");
  const { normalizePhone } = await import("@/lib/phone");
  const admin = createAdminSupabase();

  // 1. La población en riesgo: impreso en guide_code, provisional conservado.
  const promoted: Ship[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("shipments")
      .select("id,guide_code,external_order_number,order_id,delivery_status,created_at,updated_at")
      .eq("courier", "aliclik")
      .ilike("guide_code", "AUR5X%")
      .not("order_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as Ship[];
    for (const s of page) {
      if (isProvisionalGuideCode(s.external_order_number)) promoted.push(s);
    }
    if (page.length < PAGE) break;
  }
  console.log(`Guías promovidas y con pedido: ${promoted.length}`);
  if (!promoted.length) return;

  // 2. Sus pedidos.
  const orders = new Map<string, Order>();
  for (const chunk of chunked([...new Set(promoted.map((s) => s.order_id))], 200)) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name,customer_phone")
      .in("id", chunk);
    if (error) throw error;
    for (const o of (data ?? []) as Order[]) orders.set(o.id, o);
  }

  // 3. ¿Existe la convención del sufijo? Se mide antes de usarla.
  const coherent = promoted.filter((s) => {
    const o = orders.get(s.order_id);
    return o ? isCompatibleManualPortalGuide(s.guide_code, o.name) : false;
  });
  const rate = coherent.length / promoted.length;
  console.log(
    `El código termina en el número de su pedido en ${coherent.length}/${promoted.length}` +
      ` (${(rate * 100).toFixed(1)}%).`,
  );
  if (rate < 0.5) {
    console.log(
      "\nLa convención no se sostiene: el sufijo del código impreso no identifica al pedido.\n" +
        "Sin ella este detector no distingue una promoción mala de una buena. NO se listan\n" +
        "sospechosas para no señalar cientos de filas sanas. Hace falta otra señal.",
    );
    return;
  }

  const coherentIds = new Set(coherent.map((s) => s.id));
  const suspects = promoted.filter((s) => !coherentIds.has(s.id));
  console.log(`\nSospechosas (el código no es el de su pedido): ${suspects.length}`);
  if (!suspects.length) {
    console.log("Ninguna otra guía quedó en el pedido equivocado.");
    return;
  }

  // 4. ¿De quién era cada paquete? El pedido cuyo número SÍ es el sufijo.
  const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
  const wanted = new Set<string>();
  for (const s of suspects) {
    const d = digits(s.guide_code);
    for (const len of [5, 6, 7]) if (d.length >= len) wanted.add(d.slice(-len));
  }
  const bySuffix = new Map<string, Order[]>();
  for (const suffix of wanted) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name,customer_phone")
      .ilike("name", `%${suffix}`);
    if (error) throw error;
    bySuffix.set(suffix, (data ?? []) as Order[]);
  }

  let confirmed = 0;
  for (const s of suspects) {
    const linked = orders.get(s.order_id);
    const d = digits(s.guide_code);
    const candidates: Order[] = [];
    for (const len of [5, 6, 7]) {
      for (const o of bySuffix.get(d.slice(-len)) ?? []) {
        if (isCompatibleManualPortalGuide(s.guide_code, o.name) && !candidates.some((c) => c.id === o.id)) {
          candidates.push(o);
        }
      }
    }
    const samePhone = candidates.filter(
      (o) =>
        linked?.customer_phone &&
        normalizePhone(o.customer_phone) === normalizePhone(linked.customer_phone),
    );
    if (samePhone.length) confirmed += 1;

    console.log(`\n— ${s.guide_code}  (shipment ${s.id})`);
    console.log(`   cuelga de: ${linked?.name ?? "?"}   provisional propio: ${s.external_order_number}`);
    console.log(`   estado: ${s.delivery_status}${TERMINAL.has(s.delivery_status ?? "") ? "  ⚠ terminal" : ""}`);
    if (samePhone.length) {
      console.log(
        `   ES EL MISMO CASO: el paquete era de ${samePhone.map((o) => o.name).join(", ")}` +
          `, mismo teléfono que ${linked?.name}.`,
      );
    } else if (candidates.length) {
      console.log(
        `   dueño probable: ${candidates.map((o) => o.name).join(", ")} — pero con OTRO teléfono,` +
          ` así que no llegó aquí por la promoción telefónica. Revisar aparte.`,
      );
    } else {
      console.log("   sin pedido que encaje con el sufijo. Revisar a mano.");
    }
  }

  console.log(
    `\n=== ${confirmed} de ${suspects.length} son el mismo caso que AUR5X122767 ===\n` +
      "Cada una se repara igual: devolverle a la fila su código provisional, que libera el\n" +
      "impreso para que el próximo reporte lo ingeste en su pedido. Ver\n" +
      "scripts/reparar-guia-aur5x122767.ts, que hace exactamente eso para una.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
