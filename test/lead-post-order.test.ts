import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEAD_POST_ORDER_REASON,
  defaultLeadPostOrderChoice,
  leadPostOrderChoices,
  paymentSummary,
  type LeadPostOrderInput,
} from "@/lib/lead-post-order";
import { orderPaymentPanelFor } from "@/lib/order-payment-panel";
import { aliclikGuideOffered } from "@/lib/order-route-plan";
import { SWAYP_OFFER_REASON } from "@/lib/swayp-desde-confirmacion-offer";

/**
 * Después de «Generar pedido» en Leads (MOM §25.2, owner 07-11-2026): «me da la
 * opción para crear guía en Aliclik pero no me da para subir si manda un
 * adelanto de pago, tampoco para elegir agencia Shalom, y me gustaría tener el
 * de "Swayp lo puede llevar hoy"». Las tres opciones preguntan lo mismo que la
 * ficha del pedido y, si no se ofrecen, dicen por qué.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const PROVINCIA_PLAN = {
  operation: "provincia_cod" as const,
  operationLabel: "Provincia COD",
  candidates: [
    { key: "aliclik" as const, action: "aliclik" as const, availability: "available" as const, reason: "Primera ruta sugerida para Provincia COD." },
    { key: "swayp" as const, action: "swayp" as const, availability: "available" as const, reason: "" },
    { key: "shalom" as const, action: "shalom" as const, availability: "blocked" as const, reason: "Tercera ruta: requiere adelanto validado." },
    { key: "olva" as const, action: "manual" as const, availability: "blocked" as const, reason: "" },
  ],
};

const LIMA_PLAN = {
  operation: "lima" as const,
  operationLabel: "Lima",
  candidates: [
    { key: "propio" as const, action: "manual" as const, availability: "available" as const, reason: "" },
    { key: "aliclik" as const, action: "aliclik" as const, availability: "available" as const, reason: "" },
  ],
};

function input(over: Partial<LeadPostOrderInput> = {}, row: Partial<LeadPostOrderInput["row"]> = {}): LeadPostOrderInput {
  return {
    orderId: "o1",
    orderName: "#KP1",
    row: {
      current_courier: null,
      shipping_mode: "cod",
      macro_stage: "por_confirmar",
      macro_substage: "por_contactar",
      macro_reasons: [],
      coverage: "provincia_cod",
      swayp_availability: "ok",
      payment_state: "sin_pago",
      financial_status: "pending",
      total_refunded: 0,
      payment_gateway: "cod",
      guide_code: null,
      ...row,
    },
    routePlan: PROVINCIA_PLAN,
    travelsInCompanion: false,
    guides: [],
    brief: null,
    shalomDraft: null,
    perms: { canEdit: true, canCreateGuide: true, canCreateShalomGuide: true },
    ...over,
  };
}

describe("las tres opciones, con las reglas de la ficha", () => {
  it("provincia COD recién creada, Swayp ok: se ofrecen las tres", () => {
    const c = leadPostOrderChoices(input());
    expect(c.aliclik).toEqual({ offered: true, reason: null, guide: null });
    expect(c.swayp).toEqual({ offered: true, reason: null, guides: [] });
    expect(c.agencia).toMatchObject({ offered: true, reason: null, mode: "optional", payment: null, shalom: null });
    // Aliclik sigue abierta por defecto, como antes de esta tarjeta.
    expect(defaultLeadPostOrderChoice(c)).toBe("aliclik");
  });

  it("el cobro por agencia es la MISMA decisión que la tarjeta de Cobro de la ficha", () => {
    for (const i of [
      input(),
      input({ routePlan: LIMA_PLAN }, { coverage: "lima" }),
      input({ perms: { canEdit: true, canCreateGuide: true, canCreateShalomGuide: false } }),
      input({ routePlan: { ...PROVINCIA_PLAN, operation: "agencia", operationLabel: "Agencia" } }),
      input({}, { financial_status: "paid", payment_gateway: "checkout" }),
    ]) {
      const ficha = orderPaymentPanelFor({
        row: i.row,
        routePlan: i.routePlan,
        brief: i.brief,
        canCreateShalomGuide: i.perms.canCreateShalomGuide,
      });
      const leads = leadPostOrderChoices(i).agencia;
      expect(leads.offered).toBe(ficha.presentation.show);
      expect(leads.mode).toBe(ficha.presentation.mode);
      expect(leads.shalomDestination).toBe(ficha.shalomDestination);
      expect(leads.gatewayNote).toBe(ficha.gatewayNote);
    }
  });

  it("Lima sin agencia ni regla: el cobro por agencia dice por qué no", () => {
    const c = leadPostOrderChoices(input({ routePlan: LIMA_PLAN }, { coverage: "lima" }));
    expect(c.agencia.offered).toBe(false);
    expect(c.agencia.reason).toBe(LEAD_POST_ORDER_REASON.agencyNotNeeded("Lima"));
    expect(c.swayp.reason).toBe("Solo para provincia COD; este pedido es Lima.");
  });

  it("una regla de riesgo que exige adelanto lo vuelve requerido, también en Lima", () => {
    const c = leadPostOrderChoices(
      input({ routePlan: LIMA_PLAN, brief: { risk: { requirement: "exigir_adelanto" }, duplicateHold: null } }, { coverage: "lima" }),
    );
    expect(c.agencia).toMatchObject({ offered: true, mode: "required" });
  });

  it("sin `shalom.create_guide`, Shalom en el plan no vuelve visible el cobro (como en la ficha)", () => {
    const c = leadPostOrderChoices(input({ perms: { canEdit: true, canCreateGuide: true, canCreateShalomGuide: false } }));
    expect(c.agencia.offered).toBe(false);
    expect(c.agencia.reason).toBe(LEAD_POST_ORDER_REASON.agencyPermission);
  });

  it("Swayp: la regla del §11.11 y el permiso de emitir", () => {
    expect(leadPostOrderChoices(input({}, { swayp_availability: "sin_stock" })).swayp.reason).toBe(
      "Swayp no lo puede llevar hoy: sin stock swayp.",
    );
    expect(leadPostOrderChoices(input({}, { macro_stage: "preparacion" })).swayp.reason).toBe(
      SWAYP_OFFER_REASON.notPorConfirmar,
    );
    expect(
      leadPostOrderChoices(input({ perms: { canEdit: false, canCreateGuide: true, canCreateShalomGuide: true } })).swayp
        .reason,
    ).toBe(LEAD_POST_ORDER_REASON.swaypPermission);
  });

  it("Swayp: la columna vacía (pedido recién nacido) se completa con la evaluación de ahora", () => {
    expect(leadPostOrderChoices(input({}, { swayp_availability: null })).swayp.reason).toBe(
      SWAYP_OFFER_REASON.notEvaluated,
    );
    expect(leadPostOrderChoices(input({ swaypAvailabilityNow: "ok" }, { swayp_availability: null })).swayp.offered).toBe(true);
    expect(
      leadPostOrderChoices(input({ swaypAvailabilityNow: "sin_cobertura" }, { swayp_availability: null })).swayp.reason,
    ).toBe("Swayp no lo puede llevar hoy: fuera de cobertura.");
    // La columna manda cuando ya tiene valor.
    expect(
      leadPostOrderChoices(input({ swaypAvailabilityNow: "ok" }, { swayp_availability: "sin_stock" })).swayp.offered,
    ).toBe(false);
  });

  it("Aliclik: el plan de rutas, el acompañante y el permiso", () => {
    expect(
      leadPostOrderChoices(input({ perms: { canEdit: true, canCreateGuide: false, canCreateShalomGuide: true } })).aliclik
        .reason,
    ).toBe(LEAD_POST_ORDER_REASON.aliclikPermission);
    expect(leadPostOrderChoices(input({ travelsInCompanion: true })).aliclik.reason).toBe(
      LEAD_POST_ORDER_REASON.aliclikCompanion,
    );
    const agencia = leadPostOrderChoices(
      input({ routePlan: { operation: "agencia", operationLabel: "Agencia", candidates: PROVINCIA_PLAN.candidates.slice(2) } }),
    );
    expect(agencia.aliclik.reason).toBe(LEAD_POST_ORDER_REASON.aliclikNotInPlan("Agencia"));
    const frenada = leadPostOrderChoices(
      input({
        routePlan: {
          ...PROVINCIA_PLAN,
          candidates: [{ key: "aliclik", action: "aliclik", availability: "blocked", reason: "Se alcanzó el límite de salidas." }],
        },
      }),
    );
    expect(frenada.aliclik).toMatchObject({ offered: false, reason: "Se alcanzó el límite de salidas." });
  });

  it("la ficha y Leads preguntan a la misma función por Aliclik", () => {
    expect(aliclikGuideOffered({ travelsInCompanion: false, candidates: PROVINCIA_PLAN.candidates })).toBe(true);
    expect(aliclikGuideOffered({ travelsInCompanion: true, candidates: PROVINCIA_PLAN.candidates })).toBe(false);
    expect(read("components/order-drawer.tsx")).toContain("aliclikGuideOffered({");
    expect(read("app/dashboard/leads/post-order-actions.ts")).toContain("aliclikGuideOffered({");
  });
});

describe("después de una acción, la opción dice en qué quedó", () => {
  it("adelanto subido: «por validar»", () => {
    expect(paymentSummary("sin_pago")).toBeNull();
    expect(paymentSummary("adelanto_cargado")).toBe("Adelanto cargado · por validar");
    expect(paymentSummary("diferencia_cargada")).toBe("Diferencia cargada · por validar");
    expect(paymentSummary("pago_completo")).toBe("Pago completo");
    const c = leadPostOrderChoices(input({}, { payment_state: "adelanto_cargado" }));
    expect(c.agencia.payment).toBe("Adelanto cargado · por validar");
    expect(defaultLeadPostOrderChoice(c)).toBe("agencia");
  });

  it("agencia guardada", () => {
    const c = leadPostOrderChoices(
      input({ shalomDraft: { document: "46413109", terminalName: "JAEN CO" } }),
    );
    expect(c.agencia.shalom).toBe("Agencia JAEN CO · doc. 46413109");
    expect(defaultLeadPostOrderChoice(c)).toBe("agencia");
    expect(
      leadPostOrderChoices(input({ shalomDraft: { document: "46413109", terminalName: null } })).agencia.shalom,
    ).toBe("Doc. 46413109 · falta la agencia");
  });

  it("Swayp programado: la guía viva, y Aliclik ya no se ofrece", () => {
    const c = leadPostOrderChoices(
      input(
        {
          guides: [{ courier: "fenix", guide_code: "50000166047", delivery_status: "pendiente", status_category: "pending" }],
          routePlan: {
            ...PROVINCIA_PLAN,
            candidates: [{ key: "aliclik", action: "aliclik", availability: "blocked", reason: "Ya hay una salida viva." }],
          },
        },
        { current_courier: "fenix", guide_code: "50000166047", macro_stage: "en_curso" },
      ),
    );
    expect(c.swayp).toEqual({ offered: false, reason: null, guides: ["50000166047"] });
    expect(c.aliclik).toMatchObject({ offered: false, guide: null, reason: "El pedido ya tiene una guía de Swayp." });
    expect(defaultLeadPostOrderChoice(c)).toBe("swayp");
  });

  it("guía de Aliclik creada: queda como bloque permanente", () => {
    const c = leadPostOrderChoices(input({}, { current_courier: "aliclik", guide_code: "AUR5X1" }));
    expect(c.aliclik).toEqual({ offered: false, reason: null, guide: "AUR5X1" });
    expect(defaultLeadPostOrderChoice(c)).toBe("aliclik");
  });

  it("sin nada que ofrecer, ninguna se abre sola", () => {
    const c = leadPostOrderChoices(
      input(
        { routePlan: LIMA_PLAN, perms: { canEdit: false, canCreateGuide: false, canCreateShalomGuide: false } },
        { coverage: "lima" },
      ),
    );
    expect(defaultLeadPostOrderChoice(c)).toBeNull();
  });
});

describe("el cajón reutiliza las piezas de la ficha", () => {
  const panel = read("components/lead-post-order-choices.tsx");
  const drawer = read("components/leads-drawer.tsx");
  const actions = read("app/dashboard/leads/post-order-actions.ts");

  it("los mismos componentes y server actions, sin versión de Leads", () => {
    expect(panel).toContain("<AliclikGuidePanel");
    expect(panel).toContain("<PickupKeyPanel");
    expect(panel).toContain("<EnviarPorSwaypDesdeConfirmacion");
    expect(panel).toContain('origen="por_confirmar"');
    expect(panel).toContain("<DirectFenixGuideModal");
    // Ninguna escritura propia: solo la lectura de qué se ofrece.
    expect(panel).not.toMatch(/registerPayment|saveShalomOrderDraft|createDirectFenixGuide|createAliclikGuide/);
    expect(actions).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(actions).toContain("loadOrderDetail(orderId)");
    expect(actions).toContain("loadShalomOrderDraft(orderId)");
    expect(actions).toContain('canEdit: !perms.readOnly && perms.can("master.edit")');
    expect(actions).toContain('canCreateGuide: perms.can("aliclik.create_guide")');
    expect(actions).toContain('canCreateShalomGuide: perms.can("shalom.create_guide")');
    expect(actions).toContain("getLeadRoutingScope([lead.store_id], leadId)");
  });

  it("la disponibilidad de ahora se calcula con la regla de la pasada, sin escribir", () => {
    expect(actions).toContain("swaypAvailabilityFor(");
    expect(actions).toContain('.from("fenix_stock")');
  });

  it("lo que no se ofrece se dibuja apagado con su porqué, no se esconde", () => {
    expect(panel).toContain("disabled={!aliclik.offered && !aliclik.guide}");
    expect(panel).toContain("disabled={!swayp.offered && !swayp.guides.length}");
    expect(panel).toContain("disabled={!agencia.offered}");
    expect(panel).toContain("why(aliclik.reason)");
    expect(panel).toContain("why(swayp.reason)");
    expect(panel).toContain("why(agencia.reason)");
  });

  it("se refresca tras cada acción y con los avisos de la tarjeta de Cobro", () => {
    expect(panel).toContain("subscribePaymentPanelChange(orderId, source, reload)");
    expect(panel).toContain("onChanged={changed}");
    const pickup = read("components/pickup-key-panel.tsx");
    const hook = pickup.slice(pickup.indexOf("async function persistShalomDraft("), pickup.indexOf("function changeDocument("));
    expect(hook).toContain("announcePaymentPanelChange(orderId, SHALOM_DRAFT_SOURCE);");
  });

  it("el cajón la monta para cualquier lead con pedido; las opciones, en columna salvo en una tarjeta ancha", () => {
    expect(drawer).toContain("<LeadPostOrderChoices");
    expect(drawer).toContain("onChanged={() => onRegistered()}");
    expect(drawer).not.toContain("<AliclikGuidePanel");
    // Por contenedor, no por ventana: en la media columna del cajón (pantalla
    // ≥ 640 px, tarjeta ~450 px) tres en fila se leían como tres copias.
    expect(panel).toContain('export const OPTION_GRID = "grid gap-2 @2xl:grid-cols-3"');
    expect(panel).toContain('cn(SECTION_CARD, "@container")');
    expect(panel).not.toContain("sm:grid-cols-3");
  });

  it("el MOM y DEPLOY lo documentan", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("### 25.2 Después de «Generar pedido» en Leads: cómo sale y cómo se cobra (07-11-2026)");
    const deploy = read("DEPLOY.md");
    expect(deploy.indexOf("Leads: adelanto, agencia Shalom y «Swayp hoy» después de generar el pedido")).toBeGreaterThan(-1);
  });
});
