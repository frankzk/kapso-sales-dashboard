// Responder por Kapso desde la ficha del pedido (owner, 11-11-2026, MOM §25
// «Kapso»): la misma caja que Chatby, las mismas reglas de 24 h y adjuntos, por
// el envío de WhatsApp de Kapso que usa Leads, y un hecho `kapso_message`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatbyReplyWindow } from "@/lib/chatby-conversation";
import { kapsoThreadMessages } from "@/lib/order-kapso";
import { PAGO_DIFERENCIA_GESTION_KINDS, isPagoDiferenciaGestion } from "@/lib/pago-diferencia";

const read = (p: string) => readFileSync(p, "utf8");

describe("responder por Kapso desde la ficha", () => {
  it("la ventana de 24 h se mide con el último mensaje de la clienta en Kapso", () => {
    const now = new Date("2026-11-11T15:00:00Z");
    const msgs = kapsoThreadMessages([
      { id: "1", dir: "outbound", t: Date.parse("2026-11-11T14:26:00Z"), text: "plantilla carrito" },
      { id: "2", dir: "inbound", t: Date.parse("2026-11-11T15:02:00Z") - 3_600_000, text: "CONFIRMA TU PEDIDO" },
    ] as never);
    expect(chatbyReplyWindow(msgs, now)).toMatchObject({ open: true });
    const old = kapsoThreadMessages([{ id: "1", dir: "inbound", t: Date.parse("2026-11-09T10:00:00Z"), text: "hola" }] as never);
    expect(chatbyReplyWindow(old, now)).toMatchObject({ open: false });
    // Solo plantillas de la tienda: no hay ventana.
    const onlyStore = kapsoThreadMessages([{ id: "1", dir: "outbound", t: Date.parse("2026-11-11T14:00:00Z"), text: "x" }] as never);
    expect(chatbyReplyWindow(onlyStore, now)).toMatchObject({ open: false, lastCustomerAt: null });
  });

  it("queda en la Actividad y cuenta como gestión en «Pago de diferencia»", () => {
    expect(read("components/order-master-shared.tsx")).toContain('kapso_message: "Mensaje por WhatsApp (Kapso)",');
    expect(read("lib/order-timeline-fact.ts")).toContain('kapso_message: consulta("mensaje"),');
    expect(PAGO_DIFERENCIA_GESTION_KINDS).toContain("kapso_message");
    expect(isPagoDiferenciaGestion({ kind: "kapso_message", actor: "u" })).toBe(true);
  });

  it("la acción comprueba permiso, ventana al día, número de la conversación y adjuntos", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function sendOrderKapsoReply("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain('perms.can("master.edit")');
    expect(body).toContain("chatbyReplyWindow(kapsoThreadMessages(transcript)).open");
    expect(body).toContain("String(c.id) === found.conversationId)?.phone_number_id");
    expect(body).toContain("resolveChatbyAttachment(ctx, orderId, opts.attachment)");
    expect(body).toContain("sendWhatsappDocument");
    expect(body).toContain("sendWhatsappImage");
    expect(body).toContain('kind: "kapso_message"');
    expect(body).toContain("131047");
  });

  it("la pestaña Kapso usa la caja de Chatby y solo la muestra a quien puede editar", () => {
    const panel = read("components/order-kapso-panel.tsx");
    expect(panel).toMatch(/\{canEdit && \(\s*<ReplyBox\s+channel="kapso"/);
    expect(panel).toContain('badge={canEdit ? undefined : <Badge>Solo lectura</Badge>}');
    const chatby = read("components/order-chatby-panel.tsx");
    expect(chatby).toContain('channel === "kapso"\n          ? await sendOrderKapsoReply(orderId, text, { attachment })');
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toMatch(/<OrderKapsoPanel[\s\S]*?canEdit=\{canEdit\}/);
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("Responder desde la ficha (11-11-2026, owner: «permíteme responder el");
  });
});
