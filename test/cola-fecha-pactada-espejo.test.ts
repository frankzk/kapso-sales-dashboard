import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { applyServerFilters } from "@/lib/orders-master-access";
import { emptyFilters, type MasterFilters } from "@/lib/order-master-filters";

/**
 * EL ESPEJO EN POSTGREST DE LA COLA TIENE QUE DECIR LO MISMO QUE LA REGLA.
 *
 * `confirmationQueueBucket` decide en TypeScript (la tabla, el drawer) y
 * `applyServerFilters` lo repite en PostgREST (los chips, la paginación). Si
 * divergen, los chips cuentan una cosa y la tabla enseña otra, y no falla
 * ruidosamente: los números salen, solo que distintos.
 *
 * Se comprueba la URL producida, no que la línea esté escrita. La regla del
 * 16-09-2026: Vencidos es SOLO la fecha pactada incumplida; el recordatorio
 * manda a Próximos hasta su hora y a Hoy cuando llega, sea de hoy o de días
 * atrás; el ciclo solo entra cuando no hay recordatorio.
 */

const sb = createClient("http://local", "anon");
// 28-08-2026 a las 15:30 Lima (20:30 UTC).
const AHORA = new Date("2026-08-28T20:30:00.000Z");
const HOY = "2026-08-28";

function url(due: MasterFilters["confirmationDue"]): URL {
  const f: MasterFilters = { ...emptyFilters(), confirmationDue: due };
  return (applyServerFilters(sb.from("order_master").select("id"), f, AHORA) as unknown as { url: URL })
    .url;
}

describe("cola de Fecha pactada en PostgREST", () => {
  // `cq` sobrevive al cambio de pestaña, y desde que «sin fechas» es Hoy, sin
  // esta guarda «Hoy» en «Todos» traería cada pedido entregado de la base.
  it("las tres colas se acotan a Por confirmar, igual que sus conteos", () => {
    for (const due of ["vencido", "hoy", "proximo"] as const) {
      expect(url(due).searchParams.get("macro_stage")).toBe("eq.por_confirmar");
    }
  });

  it("Vencidos es solo la fecha pactada incumplida: ni un recordatorio entra ahí", () => {
    const u = url("vencido");
    expect(u.searchParams.get("confirmation_next_contact_on")).toBe(`lt.${HOY}`);
    // Antes había un `or(...)` con el recordatorio de hoy pasado. Ya no.
    expect(u.searchParams.get("or")).toBeNull();
  });

  it("Hoy: pactada de hoy, recordatorio llegado, ciclo vencido sin recordatorio, o NINGUNA fecha", () => {
    const or = decodeURIComponent(url("hoy").searchParams.get("or")!);
    expect(or).toContain(`confirmation_next_contact_on.eq.${HOY}`);
    // Llegado = su hora ya pasó, se compara contra AHORA y no contra el día:
    // así entra el de hace tres semanas igual que el de hace un minuto.
    expect(or).toContain(`confirmation_reminder_due_at.lte.${AHORA.toISOString()}`);
    // El ciclo solo manda si no hay recordatorio, ninguno — ni uno viejo.
    expect(or).toContain(`confirmation_reminder_due_at.is.null,confirmation_cycle_due_on.lte.${HOY}`);
    // Nunca llamado: sin pactada, sin recordatorio y sin ciclo. Toca hoy.
    expect(or).toContain(
      "confirmation_next_contact_on.is.null,confirmation_reminder_due_at.is.null,confirmation_cycle_due_on.is.null",
    );
    // Y no queda rastro de la ventana «de hoy» que antes acotaba el recordatorio.
    expect(or).not.toContain("confirmation_reminder_due_at.gte.");
    expect(or).not.toContain("confirmation_reminder_due_at.lt.");
  });

  it("Próximos: pactada futura, recordatorio que aún no llega, o ciclo futuro sin recordatorio", () => {
    const or = decodeURIComponent(url("proximo").searchParams.get("or")!);
    expect(or).toContain(`confirmation_next_contact_on.gt.${HOY}`);
    expect(or).toContain(`confirmation_reminder_due_at.gt.${AHORA.toISOString()}`);
    expect(or).toContain(`confirmation_reminder_due_at.is.null,confirmation_cycle_due_on.gt.${HOY}`);
    // «Sin ninguna fecha» es Hoy, nunca Próximos.
    expect(or).not.toContain("confirmation_cycle_due_on.is.null");
  });

  it("Hoy y Próximos parten el recordatorio exactamente en AHORA, sin hueco ni solape", () => {
    const hoy = decodeURIComponent(url("hoy").searchParams.get("or")!);
    const proximo = decodeURIComponent(url("proximo").searchParams.get("or")!);
    const corte = AHORA.toISOString();
    // lte en un lado, gt en el otro: cada instante cae en uno y solo uno.
    expect(hoy).toContain(`lte.${corte}`);
    expect(proximo).toContain(`gt.${corte}`);
    expect(hoy).not.toContain(`gt.${corte}`);
    expect(proximo).not.toContain(`lte.${corte}`);
  });

  it("sin cola elegida no se toca ninguna de las tres columnas", () => {
    const u = url("");
    expect(u.searchParams.get("or")).toBeNull();
    expect(u.searchParams.get("confirmation_next_contact_on")).toBeNull();
  });
});
