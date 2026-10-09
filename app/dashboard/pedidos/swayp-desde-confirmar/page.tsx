import Link from "next/link";
import { getAccessibleStores } from "@/lib/access";
import { getSwaypDesdeConfirmacionLog, type SwaypDesdeConfirmacionRow } from "@/lib/swayp-desde-confirmacion-access";
import {
  SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL,
  SWAYP_NO_ENTREGO_MOTIVO_LABEL,
  type SwaypDesdeConfirmacionOutcome,
} from "@/lib/swayp-desde-confirmacion";
import { Badge, type BadgeTone } from "@/components/ops-ui";
import { Card, EmptyState, StatCard } from "@/components/ui";

// Registro de «Swayp desde Por confirmar» (MOM §11.11): cada pedido enviado con
// el botón de la mesa de confirmación, qué hizo Swayp y qué pasó después. Sirve
// para medir el experimento: cuántos entrega Swayp sin confirmar y cuántos
// vuelven a las llamadas.

export const dynamic = "force-dynamic";

const OUTCOME_TONE: Record<SwaypDesdeConfirmacionOutcome, BadgeTone> = {
  en_camino: "info",
  entregado: "ok",
  volvio_a_confirmar: "warn",
  nueva_salida: "brand",
  anulado_shopify: "neutral",
};

const OUTCOMES = Object.keys(SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL) as SwaypDesdeConfirmacionOutcome[];

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const COURIER_NAME: Record<string, string> = { aliclik: "Aliclik", fenix: "Swayp", swayp: "Swayp", shalom: "Shalom", olva: "Olva", tanders: "Tanders", urpi: "Urpi", propio: "Grupo GF", por_definir: "Por definir" };

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : "—";
}

export default async function SwaypDesdeConfirmarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const stores = await getAccessibleStores();
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  let rows: SwaypDesdeConfirmacionRow[];
  try {
    rows = await getSwaypDesdeConfirmacionLog();
  } catch (e) {
    return <EmptyState title="No se pudo cargar el registro">{e instanceof Error ? e.message : null}</EmptyState>;
  }

  const params = await searchParams;
  const raw = typeof params.estado === "string" ? params.estado : "";
  const estado = (OUTCOMES as string[]).includes(raw) ? (raw as SwaypDesdeConfirmacionOutcome) : null;
  const visible = estado ? rows.filter((r) => r.outcome === estado) : rows;

  const count = (o: SwaypDesdeConfirmacionOutcome) => rows.filter((r) => r.outcome === o).length;
  const delivered = count("entregado");
  const failed = count("volvio_a_confirmar") + count("nueva_salida");
  const resolved = delivered + failed;

  return (
    <main className="space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link href="/dashboard/pedidos?view=por_confirmar" className="text-sm text-brand-700 hover:underline">
          ← Master de Pedidos · Por confirmar
        </Link>
        <h1 className="text-2xl font-semibold text-ink-900">Swayp desde Por confirmar</h1>
        <p className="max-w-3xl text-sm text-ink-600">
          Pedidos de provincia COD enviados por Swayp con el botón de la mesa de confirmación, sin confirmar. Si Swayp
          no entrega, el pedido vuelve a «Por confirmar · Swayp no entregó» para llamarlo otra vez.
        </p>
      </div>

      {!rows.length ? (
        <EmptyState title="Todavía no hay envíos con este botón">
          El botón «Enviar por Swayp» aparece en la ficha de los pedidos de provincia COD en Por confirmar que Swayp
          puede llevar hoy.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Enviados" value={String(rows.length)} sub={`${count("en_camino")} todavía en camino`} />
            <StatCard label="Entregados por Swayp" value={String(delivered)} sub={`${pct(delivered, resolved)} de los ya resueltos`} />
            <StatCard label="Swayp no entregó" value={String(failed)} sub={`${count("volvio_a_confirmar")} en Por confirmar · ${count("nueva_salida")} salieron por otra vía`} />
            <StatCard label="Anulados en Shopify" value={String(count("anulado_shopify"))} />
          </div>

          <nav aria-label="Filtrar por resultado" className="flex flex-wrap gap-2">
            <FilterLink href="/dashboard/pedidos/swayp-desde-confirmar" active={!estado} label={`Todos · ${rows.length}`} />
            {OUTCOMES.map((o) => (
              <FilterLink
                key={o}
                href={`/dashboard/pedidos/swayp-desde-confirmar?estado=${o}`}
                active={estado === o}
                label={`${SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL[o]} · ${count(o)}`}
              />
            ))}
          </nav>

          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Pedido</th>
                  <th className="px-4 py-2 font-medium">Destino</th>
                  <th className="px-4 py-2 font-medium">Enviado</th>
                  <th className="px-4 py-2 font-medium">Guía Swayp</th>
                  <th className="px-4 py-2 font-medium">Resultado</th>
                  <th className="px-4 py-2 font-medium">Después</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={`${r.orderId}-${r.sentAt}`} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/pedidos?abrir=${encodeURIComponent(r.orderId)}`} className="font-medium text-brand-700 hover:underline">
                        {r.orderName ?? "Pedido"}
                      </Link>
                      <p className="text-xs text-ink-500">
                        {storeName.get(r.storeId) ?? "—"}
                        {r.orderTotal != null && ` · S/ ${r.orderTotal.toFixed(2)}`}
                      </p>
                      {r.customerName && <p className="text-xs text-ink-500">{r.customerName}</p>}
                    </td>
                    <td className="px-4 py-3 text-ink-700">{r.destination ?? "—"}</td>
                    <td className="px-4 py-3">
                      <p className="text-ink-700">{when(r.sentAt)}</p>
                      {r.sentBy && <p className="text-xs text-ink-500">{r.sentBy}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-ink-700">{r.guideCode ?? "—"}</p>
                      <p className="text-xs text-ink-600">{r.swaypStateLabel ?? "Sin estado de Swayp"}</p>
                      {r.novelty && <p className="text-xs text-ink-500">{r.novelty}</p>}
                    </td>
                    <td className="space-y-1 px-4 py-3">
                      <Badge tone={OUTCOME_TONE[r.outcome]}>{SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL[r.outcome]}</Badge>
                      {r.motivo && (
                        <div>
                          <Badge tone={r.motivo === "rechazo_en_puerta" ? "crit" : r.motivo === "falla_swayp" ? "warn" : "neutral"}>
                            {SWAYP_NO_ENTREGO_MOTIVO_LABEL[r.motivo]}
                          </Badge>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-700">
                      {r.nextOutput ? (
                        <>
                          <p>{COURIER_NAME[r.nextOutput.courier] ?? r.nextOutput.courier}</p>
                          <p className="text-xs text-ink-500">
                            {r.nextOutput.guideCode ?? "sin guía"} · {r.nextOutput.deliveryStatus.replace("_", " ")}
                          </p>
                        </>
                      ) : r.outcome === "volvio_a_confirmar" ? (
                        <p className="text-xs text-ink-500">Esperando la llamada</p>
                      ) : (
                        <p className="text-xs text-ink-500">—</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-ink-500">
            «Swayp no entregó» incluye Devolución (8, 9, 12), la caja ya de vuelta y la guía anulada. Una novedad abierta (6)
            sigue en camino: Swayp todavía puede entregarla. Se muestran los últimos 300 envíos.
          </p>
        </>
      )}
    </main>
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
          : "rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50"
      }
    >
      {label}
    </Link>
  );
}
