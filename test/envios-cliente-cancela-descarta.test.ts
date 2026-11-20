// Owner, 20-11-2026, #KP203721: «si volvemos a llamar para enviar con Swayp un
// pedido y el cliente ya no quiere, ¿cómo lo quitamos de la lista de pendientes
// de llamar? No queremos anular el pedido como tal, sino que ya no nos lo ponga
// en la tabla para volver a llamar».
//
// La asesora usó «Cliente cancela / anula» con «que yab no lo desea». La guía
// Aliclik quedó anulada, pero ya había fallado afuera (NOT_RESPOND · TO_RETURN):
// anularla es justo lo que abre la recuperación (MOM §11), así que el pedido
// volvió en el mismo segundo a «En gestión Reproprovincia» y a la cola, con 7
// días más de llamadas. Igual #KP206303, #KP206015 y #KP205943.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECOVERY_DISCARDED_KIND, recoveryOutcome } from "@/lib/reproprovincia";
import { DISCARD_REASON_MIN } from "@/lib/recovery-discard";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

// La guía de #KP203721 después de «Cliente cancela / anula».
const guide = {
  courier: "aliclik",
  delivery_status: "anulado",
  reported_status: "NOT_RESPOND · TO_RETURN · CONFIRMED",
  dispatched_at: "2026-11-12T02:00:01.513Z",
  closed_at: "2026-11-20T19:27:55.152Z",
  returned_at: null,
  updated_at: "2026-11-20T19:27:55.123Z",
};
const NOW = "2026-11-20T20:00:00Z";

describe("anular una guía Aliclik que ya falló abre la recuperación", () => {
  it("sin descarte, el pedido vuelve a la cola: por eso #KP203721 seguía ahí", () => {
    expect(recoveryOutcome([guide], [], NOW, 7)).toBe("activa");
  });

  it("con el descarte, sale de la cola y el pedido va a cierre", () => {
    const events = [{ kind: RECOVERY_DISCARDED_KIND, occurred_at: "2026-11-20T19:27:56Z" }];
    expect(recoveryOutcome([guide], events, NOW, 7)).toBe("descartada");
  });
});

describe("«Cliente cancela / anula» descarta la recuperación", () => {
  const src = read("app/dashboard/envios/actions.ts");
  const start = src.indexOf("export async function registerRerouteCall(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  it("pide el mismo motivo que el descarte, antes de tocar la guía", () => {
    const motivo = body.indexOf('input.disposition === "cancela" ? validarMotivoDescarte(input.note) : null');
    expect(motivo).toBeGreaterThan(-1);
    expect(motivo).toBeLessThan(body.indexOf(".update({"));
  });

  it("descarta solo si la anulación deja la recuperación activa, con el mismo hecho que «Cliente no quiere»", () => {
    expect(body).toContain('if (decidida?.recovery === "activa") {');
    expect(body).toContain("await discardRecovery(admin, {");
    expect(body).toContain('payload: { via: "cliente_cancela", shipment_id: shipmentId },');
    // Después de anular y anotar la llamada (el ancla de la ventana), antes de
    // recalcular el Master: así el pedido se recalcula una vez y ya descartado.
    const discard = body.indexOf("await discardRecovery(admin, {");
    expect(discard).toBeGreaterThan(body.indexOf('from("shipment_calls").insert'));
    expect(discard).toBeLessThan(body.lastIndexOf("await syncMasterForShipment(admin, shipmentId);"));
  });

  it("si el descarte falla, lo dice en vez de dar la anulación por buena", () => {
    expect(body).toContain("La guía quedó anulada, pero el pedido sigue en Reproprovincia");
  });

  it("el cajón pide el motivo y dice que no se vuelve a llamar", () => {
    const ui = read("components/shipments.tsx");
    expect(ui).toContain('const cancelReasonMissing = disposition === "cancela" && note.trim().length < DISCARD_REASON_MIN;');
    expect(ui).toContain("disabled={pending || cancelReasonMissing}");
    expect(ui).toContain("Anula la guía, el pedido pasa a cierre y no se vuelve a llamar.");
    expect(DISCARD_REASON_MIN).toBe(8);
  });
});
