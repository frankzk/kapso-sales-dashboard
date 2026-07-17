import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), "utf8");

describe("Leads drawer performance paths", () => {
  it("avoids a remote auth round trip for every drawer action", () => {
    const actions = read("app", "dashboard", "leads", "actions.ts");
    const authorize = actions.slice(actions.indexOf("async function authorizeLead"), actions.indexOf("/** Claim a lead"));

    expect(authorize).toContain("sb.auth.getClaims()");
    expect(authorize).not.toContain("sb.auth.getUser()");
  });

  it("paints the known active Kapso thread before discovering older sessions", () => {
    const actions = read("app", "dashboard", "leads", "actions.ts");

    expect(actions).toContain("if (!includeOlder && !conversationId && storedId)");
    expect(actions).toContain("fetchConversationTranscript({ apiKey }, storedId, 1)");
  });

  it("keeps call saves local and WhatsApp sends optimistic", () => {
    const board = read("components", "leads.tsx");
    const drawer = read("components", "leads-drawer.tsx");

    expect(board).toContain("if (update.refreshList) router.refresh()");
    expect(drawer).toContain('status: "sending"');
    expect(drawer).toContain("onSendSettled(localId, res.sentMessage ?? null)");
    expect(drawer).toContain('startUiMeasure("kapso:call-save")');
    expect(drawer).toContain('startUiMeasure("kapso:whatsapp-send")');
  });
});
