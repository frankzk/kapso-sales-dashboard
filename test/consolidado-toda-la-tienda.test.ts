import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dateHourPattern } from "@/lib/metrics";
import type { OrderRow } from "@/lib/types";

// Primero toda la tienda; el chatbot de Kapso, aparte y con su nombre (owner,
// 31-10-2026; MOM §17.4.2).
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const dash = read("components/executive-dashboard.tsx");
const storePage = read("app/dashboard/[storeId]/page.tsx");

describe("Consolidado: toda la tienda primero", () => {
  it("la página de una tienda pide las líneas de todas las ventas y se las pasa al tablero", () => {
    expect(storePage).toContain("getSalesProductOrders([storeId], range)");
    expect(storePage).toContain("productOrders={productOrders}");
  });

  it("las líneas de todas las ventas se cortan en el día LOCAL de cada tienda, como la cabecera", () => {
    const access = read("lib/access.ts");
    const fn = access.slice(access.indexOf("export async function getSalesProductOrders"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("acquisitionRangeBounds(range, ");
    expect(body).toContain('.lt("created_at", endExclusiveIso)');
    expect(body).not.toContain("rangeBounds(range)");
  });

  it("«Productos» y «Patrón de horas» cuentan todas las ventas cuando llegan", () => {
    expect(dash).toContain("dateHourPattern(productOrders ?? orders, timezone)");
    expect(dash).toContain("topProducts(productOrders ?? orders, Number.POSITIVE_INFINITY)");
  });

  it("la cabecera solo lleva cifras de toda la tienda", () => {
    const head = dash.slice(dash.indexOf('<dl className={cn(FIGURE_FRAME, "grid-cols-2 lg:grid-cols-3")}>'));
    const dl = head.slice(0, head.indexOf("</dl>"));
    expect(dl).toContain("label={`Ingresos${of}`}");
    expect(dl).not.toContain("Conversión del bot");
    expect(dl).not.toContain("Primera respuesta");
  });

  it("los grupos van de la tienda al canal y, al final, el chatbot de Kapso con su nombre", () => {
    const labels = [...dash.matchAll(/\{ id: "[a-z]+", label: "([^"]+)", cells:/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "Ventas de toda la tienda",
      "Por canal y origen",
      "Chatbot de Kapso: sus ventas",
      "Chatbot de Kapso: lo que se pierde",
      "Chatbot de Kapso: números y sistema",
    ]);
    expect(dash).toContain("cells: [conversion, primeraRespuesta, fuente, carritos, negocio]");
    expect(dash).toContain('title: "Primera respuesta del bot"');
    expect(dash).toContain('title: "Fuente de las ventas del bot"');
  });

  it("el patrón de horas cuenta cualquier pedido activo, sea del bot o no", () => {
    const orders = [
      { id: "a", created_at: "2026-10-30T20:05:00Z", cancelled_at: null, tags: [] },
      { id: "b", created_at: "2026-10-30T20:40:00Z", cancelled_at: null, tags: ["kapso"] },
      { id: "c", created_at: "2026-10-30T20:50:00Z", cancelled_at: "2026-10-30T21:00:00Z", tags: [] },
    ] as unknown as OrderRow[];
    const p = dateHourPattern(orders, "America/Lima");
    expect(p.peak?.count).toBe(2);
    expect(p.peak?.hour).toBe(15);
  });
});
