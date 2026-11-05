// La dirección que recibe Swayp (owner, 05-11-2026; MOM §11.6.2). Swayp la
// recibe al crear la guía y su API no la deja cambiar: KP143594-S02 se creó a
// las 12:57:16 y la referencia se agregó a las 12:58:43, sin llegarle nunca.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWAYP_ADDRESS_LIVE_BEFORE,
  SWAYP_ADDRESS_NOT_SENT,
  SWAYP_REROUTE_ADDRESS_CONFIRM,
  SWAYP_REROUTE_ADDRESS_NOTE,
  SWAYP_REROUTE_ADDRESS_REQUIRED,
  SWAYP_REROUTE_ADDRESS_TITLE,
  SWAYP_REROUTE_NO_REFERENCE,
  swaypAddressLine,
  swaypLiveGuides,
  swaypMotiveMentionsAddress,
} from "@/lib/swayp-address";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const guide = (extra: Record<string, unknown> = {}) => ({
  courier: "fenix",
  guide_code: "50000166047",
  swayp_guide: "50000166047",
  delivery_status: "en_ruta",
  status_category: "in_route",
  swayp_state: 4,
  ...extra,
});

describe("qué guía Swayp sigue viva (Swayp la tiene con la dirección con que se creó)", () => {
  it("la de KP143594-S02, asignada en Arequipa", () => {
    expect(swaypLiveGuides([guide()])).toEqual(["50000166047"]);
    expect(SWAYP_ADDRESS_NOT_SENT(["50000166047"])).toBe(
      "Ojo: Swayp ya tiene la guía 50000166047 con la dirección anterior y este cambio no le llega. Avísale a Swayp la dirección, la referencia y la ubicación; si vuelve con novedad, ponlas en el comentario al resolverla.",
    );
    expect(SWAYP_ADDRESS_LIVE_BEFORE(["1", "2"])).toContain("las guías 1, 2 con la dirección anterior");
  });

  it("no cuentan las cerradas, las de otro courier ni las que no tienen número", () => {
    expect(swaypLiveGuides([
      guide({ delivery_status: "anulado", status_category: "closed" }),
      guide({ delivery_status: "entregado", status_category: "delivered" }),
      guide({ swayp_state: 8 }),
      guide({ swayp_state: 12 }),
      guide({ courier: "aliclik" }),
      guide({ guide_code: null, swayp_guide: null }),
    ])).toEqual([]);
    // Sin estado de Swayp (una fila del Master o la salida enlazada) cuenta si sigue abierta.
    expect(swaypLiveGuides([{ courier: "fenix", guide_code: "50000166047", delivery_status: "en_proceso" }])).toEqual(["50000166047"]);
    // La misma guía dos veces (la salida y su enlace) se nombra una vez.
    expect(swaypLiveGuides([guide(), guide()])).toEqual(["50000166047"]);
  });
});

describe("lo que va a recibir Swayp en la excepción sobre una guía anulada", () => {
  it("la referencia va pegada al final con « - », como la ve el mensajero", () => {
    expect(swaypAddressLine("Av Los Pioneros", "SANTA MARIA ETAPA 1 MZ S LT 1")).toBe("Av Los Pioneros - SANTA MARIA ETAPA 1 MZ S LT 1");
    expect(swaypAddressLine("Av Los Pioneros", "  ")).toBe("Av Los Pioneros");
    // El mismo separador que manda la guía (lib/swayp-guide.ts).
    expect(read("lib/swayp-guide.ts")).toContain("adicionalDireccion: ` - ${b.reference.trim()}`");
  });

  it("si el motivo habla de la dirección, hay que confirmar que ya se corrigió", () => {
    expect(swaypMotiveMentionsAddress("NO LO ENTREGARON POR ERROR DE DIRECCION")).toBe(true);
    expect(swaypMotiveMentionsAddress("faltaba la referencia")).toBe(true);
    expect(swaypMotiveMentionsAddress("ubicación mal puesta")).toBe(true);
    expect(swaypMotiveMentionsAddress("Cliente confirmó para el lunes")).toBe(false);
    expect(swaypMotiveMentionsAddress(null)).toBe(false);
  });
});

describe("dónde se aplica", () => {
  it("Envíos: aviso antes de guardar el destino, vista previa y confirmación en la excepción", () => {
    const ui = read("components/shipments.tsx");
    expect(ui).toContain("{swaypGuidesLive.length > 0 && <Banner tone=\"warn\">{SWAYP_ADDRESS_LIVE_BEFORE(swaypGuidesLive)}</Banner>}");
    expect(ui).toContain("{SWAYP_REROUTE_ADDRESS_TITLE}");
    expect(ui).toContain("swaypAddressLine(swaypAddressPreview, swaypReferencePreview)");
    expect(ui).toContain("{SWAYP_REROUTE_NO_REFERENCE}");
    expect(ui).toContain("{SWAYP_REROUTE_ADDRESS_CONFIRM}");
    expect(ui).toContain("(!cancelledExceptionNeedsAddressOk || cancelledExceptionAddressOk)");
    expect(ui).toContain("addressConfirmed: cancelledExceptionAddressOk,");
  });

  it("el servidor exige la confirmación antes de crear la guía, y avisa después de corregir", () => {
    const envios = read("app/dashboard/envios/actions.ts");
    const exception = envios.slice(envios.indexOf("export async function reprogramCancelledShipmentException("));
    const guard = exception.indexOf("if (swaypMotiveMentionsAddress(input.note) && !input.addressConfirmed) {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(exception.indexOf("reenviarGuiaAnulada("));
    expect(envios).toContain("await swaypAddressNotSent(admin, current.order_id, targetIds)");
    const master = read("app/dashboard/pedidos/actions.ts");
    const geo = master.slice(master.indexOf("export async function updateOrderGeo("));
    expect(geo.slice(0, geo.indexOf("/** Devuelve la corrección vigente"))).toContain("SWAYP_ADDRESS_NOT_SENT(guides)");
    expect(read("components/order-drawer.tsx")).toContain("<Banner tone=\"warn\">{SWAYP_ADDRESS_LIVE_BEFORE(guides)}</Banner>");
  });

  it("el agente de voz no pasa por esta pantalla y no cambia", () => {
    expect(read("lib/swayp-reenvio.ts")).not.toContain("swayp-address");
  });
});

describe("el MOM (§11.6.2)", () => {
  const mom = flat(read("docs/mom/master-pedidos-v1.md"));
  it("cuenta el caso, la causa y lo que hace Kapta, con los textos tal cual", () => {
    expect(mom).toContain("#### 11.6.2 La dirección que recibe Swayp (05-11-2026)");
    expect(mom).toContain("«Se puso más detalle en referencia, y no lo jala?»");
    expect(mom).toContain("Su API no tiene forma de cambiarlas después");
    for (const quote of [
      SWAYP_ADDRESS_LIVE_BEFORE(["50000166047"]),
      SWAYP_ADDRESS_NOT_SENT(["50000166047"]),
      SWAYP_REROUTE_NO_REFERENCE,
      SWAYP_REROUTE_ADDRESS_CONFIRM,
      SWAYP_REROUTE_ADDRESS_REQUIRED,
    ]) {
      expect(mom, quote).toContain(`«${quote}»`);
    }
    expect(mom).toContain(`«${SWAYP_REROUTE_ADDRESS_TITLE}»`);
    expect(mom).toContain(`«${SWAYP_REROUTE_ADDRESS_NOTE}»`);
  });
});
