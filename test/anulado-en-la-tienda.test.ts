// MOM §38.12 (decisión del owner, 24-10-2026): un pedido anulado se dice
// «anulado en la tienda», el mismo texto para Shopify y WooCommerce.
//
// El caso que lo trajo: Aurela ya vende en WooCommerce, y un pedido anulado en
// wp-admin también tiene `orders.cancelled_at` (`mapWooOrder`), así que todos
// los textos que lo leen le decían «anulado en Shopify». Solo cambia el texto:
// las claves (`anulado_en_shopify`, `anulado_shopify`), los tipos de hecho y
// los nombres internos se quedan. Nada aquí llama a Shopify, a WooCommerce ni a
// una base de verdad.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/order-master", () => ({ recomputeOrderMasterSafe: async () => undefined }));
vi.mock("@/lib/order-companion-access", () => ({
  loadCompanionRides: async () => [],
  loadOrderTotals: async () => new Map(),
}));

import { SHOPIFY_CANCELLED_REASON, masterDoorVerdict, shopifyCancelledNotice } from "@/lib/master-door";
import { GF_OPEN_ROUTE_CANCELLED_ERROR } from "@/lib/closure-blocks";
import { terminalOrderBlocker } from "@/lib/order-status";
import { cancelledScanMessage } from "@/lib/scan-cancelled";
import {
  SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL,
  swaypDesdeConfirmacionOutcome,
} from "@/lib/swayp-desde-confirmacion";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("los textos de la anulación dicen «la tienda»", () => {
  it("la puerta a «entregado» y su aviso al cerrar una ruta", () => {
    expect(SHOPIFY_CANCELLED_REASON).toBe(
      "El pedido está anulado en la tienda: la entrega no se escribe encima. Decide una persona desde su ficha.",
    );
    // La clave sigue siendo la de siempre: quien llama filtra por ella.
    expect(masterDoorVerdict({ target: "entregado" }, { cancelledAt: "2026-10-24T15:00:00Z" })).toEqual({
      ok: false,
      code: "anulado_en_shopify",
      reason: SHOPIFY_CANCELLED_REASON,
    });
    expect(shopifyCancelledNotice([{ orderId: "w1", name: "#AUR900004" }])).toBe(
      "#AUR900004 está anulado en la tienda: no se marcó entregado en el Master y sigue donde estaba. Decide en su ficha qué pasó con la entrega.",
    );
  });

  it("la Mesa de cierre y su servidor dicen lo mismo, sin nombrar la plataforma", () => {
    expect(GF_OPEN_ROUTE_CANCELLED_ERROR).toContain("pero el pedido está anulado en la tienda: terminar la ruta en");
    const desk = flat(read("components/order-closure-desk.tsx"));
    expect(desk).toContain("pero el pedido está anulado en la tienda: terminar la ruta en");
    expect(desk).not.toContain("storePlatform");
    // La ficha ya no le pasa la plataforma a la Mesa.
    const drawer = flat(read("components/order-drawer.tsx"));
    const tag = drawer.slice(drawer.indexOf("<OrderClosureDesk"), drawer.indexOf("/>", drawer.indexOf("<OrderClosureDesk")));
    expect(tag).not.toContain("storePlatform");
  });

  it("el estado cerrado, el escaneo y los acompañantes", () => {
    expect(terminalOrderBlocker("anulado")).toContain("si lo anuló la tienda o el courier");
    expect(
      cancelledScanMessage({ orderName: "#AUR900004", cancelledAt: "2026-10-24T15:00:00Z", cancelReason: null, generalStatus: "anulado" }),
    ).toBe("#AUR900004 está ANULADO en la tienda (el 24/10): no sale. Sepáralo para devolverlo al stock.");
    expect(read("lib/order-companion.ts")).toContain('"Este pedido está anulado en la tienda: no viaja en ninguna caja."');
  });

  it("Swayp desde Por confirmar: la etiqueta cambia, la clave `anulado_shopify` se queda", () => {
    expect(SWAYP_DESDE_CONFIRMACION_OUTCOME_LABEL.anulado_shopify).toBe("Anulado en la tienda");
    expect(
      swaypDesdeConfirmacionOutcome({
        guide: { courier: "fenix", delivery_status: "en_transito" },
        laterOutputs: [],
        cancelledAt: "2026-10-24T15:00:00Z",
      }),
    ).toBe("anulado_shopify");
    const page = read("app/dashboard/pedidos/swayp-desde-confirmar/page.tsx");
    expect(page).toContain('<StatCard label="Anulados en la tienda" value={String(count("anulado_shopify"))} />');
  });

  it("la guía Swayp directa: el servidor y el modal", () => {
    const server = read("lib/swayp-directa.ts");
    expect(server).toContain('{ error: "El pedido está anulado en la tienda; no se puede crear la guía." }');
    expect(server).toContain('{ error: "El pedido fue reembolsado por completo en la tienda; no se puede crear la guía." }');
    const modal = read("components/direct-fenix-guide-modal.tsx");
    expect(modal).toContain('"El pedido está anulado en la tienda; no se puede crear la guía."');
  });

  it("Tanders, Urpi, el cuaderno, Repro Lima, Leads y las hojas", () => {
    expect(read("lib/tanders/payment-sweep.ts")).toContain(
      "No se pudo comprobar qué guías validadas tienen el pedido anulado en la tienda: no se creó ninguna ficha.",
    );
    const cobros = flat(read("components/tanders-cobros.tsx"));
    expect(cobros).toContain('"1 guía validada sin ficha es de un pedido anulado en la tienda"');
    expect(cobros).toContain("guías validadas sin ficha son de pedidos anulados en la tienda`}");
    expect(read("lib/urpi-report-apply.ts")).toContain("anulados en la tienda o devueltos no se tocaron");
    const urpi = read("components/urpi-results-board.tsx");
    expect(urpi).toContain(
      "pero el pedido está anulado en la tienda o devuelto. No se marca entregado: solo la tienda termina una venta. Si se rehízo el pedido en la tienda, vincúlalo al nuevo;",
    );
    expect(urpi).toContain("`Anulado en la tienda el ${");
    expect(urpi).toContain("Anulado solo en Kapta; en la tienda sigue vivo, así que se puede marcar.");
    expect(read("lib/notebook-import.ts")).toContain("`Anulado en la tienda: no se carga; si ${ctx.riderName} tiene el paquete");
    expect(read("app/dashboard/pedidos/repro-lima/actions.ts")).toContain("No anula la venta: solo la tienda la anula.");
    expect(read("components/repro-lima-sheet.tsx")).toContain('text: "Espera que la tienda anule la venta"');
    expect(read("components/repro-lima-board.tsx")).toContain("hasta que la tienda anule la venta.");
    expect(read("app/dashboard/leads/actions.ts")).toContain("Si el cliente canceló, anula el pedido en la tienda primero.");
    expect(read("components/sheets-board.tsx")).toContain("una cancelación del courier nunca anula el pedido en la tienda.");
  });
});

// Ninguna pantalla ni mensaje del servidor vuelve a decir que un pedido está
// anulado «en Shopify». Los comentarios no cuentan, y el título del hecho viejo
// `cancelled_shopify` se queda a propósito: es de un pedido de Shopify (38.3).
describe("barrido: nadie dice «anulado en Shopify»", () => {
  const OLD = [
    /\b(anulad[oa]s?|ANULAD[OA]S?|cancelad[oa]s?) en Shopify\b/,
    /\banul[oó] Shopify\b/,
    /\bShopify (la |lo )?anul/,
    /\bcancela el pedido en Shopify\b/,
    /\banula el pedido Shopify\b/,
    /\ben Shopify sigue vivo\b/,
  ];
  const ALLOWED = new Set(['  cancelled_shopify: "Anulado en Shopify",']);

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  it("app/, components/ y lib/", () => {
    const hits: string[] = [];
    for (const root of ["app", "components", "lib"]) {
      for (const file of sources(resolve(process.cwd(), root))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          const code = line.trim();
          if (/^(\/\/|\*|\/\*|\{\/\*)/.test(code)) return;
          if (ALLOWED.has(line)) return;
          if (OLD.some((re) => re.test(line))) hits.push(`${file.slice(process.cwd().length + 1)}:${i + 1}: ${code}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("MOM §38.12", () => {
  const mom = read("docs/mom/master-pedidos-v1.md");
  const s38_12 = flat(mom.slice(mom.indexOf("### 38.12 "), mom.indexOf("### 38.13 ")));

  it("fija la regla y marca hecho el pendiente", () => {
    expect(s38_12).toContain("#### El pedido anulado se dice «anulado en la tienda» (24-10-2026)");
    expect(s38_12).toContain("**Decisión del owner (24-10-2026):** un solo texto para las dos plataformas, «anulado en la tienda»");
    expect(s38_12).toContain("**Textos que decían «anulado en Shopify» de cualquier pedido:** **hecho (24-10-2026)**");
    expect(s38_12).not.toContain("**Textos que todavía dicen «Shopify» sobre un pedido**");
    expect(s38_12).toContain("`test/anulado-en-la-tienda.test.ts`");
  });

  it("la Mesa de cierre ya no está entre los componentes que nombran la tienda del pedido", () => {
    // Su prop de plataforma se quitó: dice «anulado en la tienda» (revisión del 24-10-2026).
    const start = s38_12.indexOf("Implementación del enlace y del nombre de la tienda:");
    expect(start).toBeGreaterThan(-1);
    const list = s38_12.slice(start, s38_12.indexOf("Pruebas:", start));
    expect(list).toContain("`order-drawer.tsx`");
    expect(list).not.toContain("order-closure-desk.tsx");
    expect(read("components/order-closure-desk.tsx")).not.toMatch(/storePlatform|orderPlatformName/);
  });

  it("los pasajes que citan los mensajes dicen lo que dice el código", () => {
    for (const old of [
      "está anulado en Shopify: no se marcó",
      "está ANULADO en Shopify (el",
      "solo Shopify la anula",
      "Espera que Shopify anule la venta",
      "salió por otra vía, anulado en Shopify",
    ]) {
      expect(flat(mom), old).not.toContain(old);
    }
    expect(flat(mom)).toContain(
      "«#KP137541 está anulado en la tienda: no se marcó entregado en el Master y sigue donde estaba. Decide en su ficha qué pasó con la entrega.»",
    );
    expect(flat(mom)).toContain("«#AUR177767 está ANULADO en la tienda (el 04/10, lo canceló el cliente): no sale. Sepáralo para devolverlo al stock.»");
    expect(flat(mom)).toContain("«No anula la venta: solo la tienda la anula.»");
  });
});
