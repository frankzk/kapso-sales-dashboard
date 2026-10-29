import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isInCallQueue, callAttemptLabel, prioritizeDueAppointments } from "@/lib/lead-call-queue";
import { matchesQueueState, countQueueStates, pickNextLead } from "@/lib/leads";
import { leadMembership, patchLeadCounts } from "@/lib/leads-local-update";
import { LeadAttemptBadge } from "@/components/lead-attempt-badge";
import type { LeadRow } from "@/lib/types";

const retry = { id: "retry", status: "no_responde", category: "open", call_queue_ready: true,
  call_attempt_count: 1, claimed_by: null, claimed_at: null };

describe("Por llamar incluye reintentos sin borrar la gestión", () => {
  it("new and ready retries share one queue, not En seguimiento", () => {
    for (const lead of [{ status: "nuevo" }, retry]) {
      expect(matchesQueueState(lead,"sin_llamar")).toBe(true);
      expect(matchesQueueState(lead,"seguimiento")).toBe(false);
    }
    expect(retry.status).toBe("no_responde");
    expect(countQueueStates([retry,{status:"nuevo"},{status:"cuelga"}])).toEqual({sin_llamar:2,seguimiento:1});
  });
  it.each(["sin_stock","cancelado_cliente","nr_no_existe","pedido_generado","yape_por_verificar"])("never includes %s on a stale ready flag", status => {
    expect(isInCallQueue({...retry,status})).toBe(false);
  });
  it.each(["won","lost"])("never includes %s even with an open disposition", category => {
    expect(isInCallQueue({...retry,category})).toBe(false);
  });
  it("respects opt-out for both new and retry leads",()=>{
    expect(isInCallQueue({...retry,contact_opt_out_at:"2026-10-29"})).toBe(false);
    expect(isInCallQueue({status:"nuevo",contact_opt_out_at:"2026-10-29"})).toBe(false);
  });
  it("a newly linked order removes a stale retry from the queue",()=>{
    expect(isInCallQueue({...retry,has_order:true})).toBe(false);
    expect(isInCallQueue({...retry,order_id:"linked-order"})).toBe(false);
  });
  it("a follow-up waits outside the queue until the server confirms it is due",()=>{
    expect(isInCallQueue({...retry,call_queue_ready:false})).toBe(false);
  });
  it("next-lead card can reserve the retry but respects another advisor's live claim",()=>{
    expect(pickNextLead([retry],{userId:"me"})?.id).toBe("retry");
    expect(pickNextLead([{...retry,claimed_by:"other",claimed_at:new Date().toISOString()}],{userId:"me"})).toBeNull();
  });
  it("confirmed call removes retry from queue counts without changing historical rows",()=>{
    const before=retry as LeadRow;
    expect(leadMembership(before).sin_llamar).toBe(1);
    const counts={por_llamar:1,handoff:0,yape:0,seguimientos:0,ganados:0,perdidos:0,sin_llamar:1};
    expect(patchLeadCounts(counts,before,{call_queue_ready:false,call_attempt_count:2}).sin_llamar).toBe(0);
    expect(before.status).toBe("no_responde");
  });
});

describe("intento visible y citas acordadas",()=>{
  it.each([[0,"Primer intento"],[1,"Segundo intento"],[2,"Tercer intento"],[3,"4.º intento"]])("labels %s previous human calls honestly",(n,label)=>{
    expect(callAttemptLabel({call_attempt_count:Number(n)})).toBe(label);
  });
  it("uses a readable badge in existing UI and hides it for inactive followups",()=>{
    const html=renderToStaticMarkup(createElement(LeadAttemptBadge,{lead:retry}));
    expect(html).toContain("Segundo intento");
    expect(html).toContain("historial");
    expect(renderToStaticMarkup(createElement(LeadAttemptBadge,{lead:{...retry,call_queue_ready:false}}))).toBe("");
  });
  it("due appointments come first, preserving intent ranking for all other leads",()=>{
    const rows=[{id:"fresh-cart"},{id:"older-cart"},{id:"due",call_queue_ready:true,next_followup_at:"2026-10-29T15:00:00Z"},
      {id:"future",call_queue_ready:true,next_followup_at:"2026-10-30T15:00:00Z"}];
    expect(prioritizeDueAppointments(rows,Date.parse("2026-10-29T16:00:00Z")).map(l=>l.id))
      .toEqual(["due","fresh-cart","older-cart","future"]);
    expect(rows[0]!.id).toBe("fresh-cart");
  });
});
