import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readComponent = (name: string) =>
  readFileSync(resolve(process.cwd(), "components", name), "utf8");

describe("Leads client bundle boundaries", () => {
  it("keeps the operational drawer out of the initial Leads module", () => {
    const board = readComponent("leads.tsx");

    expect(board).toContain('import("@/components/leads-drawer")');
    expect(board).toContain("dynamic<LeadDrawerProps>");
    expect(board).not.toContain("function WhatsappChat(");
    expect(board).not.toContain("function OrderFormPanel(");
    expect(board).not.toContain("function CallForm(");
  });

  it("keeps the drawer features and real open-time measurement wired", () => {
    const board = readComponent("leads.tsx");
    const drawer = readComponent("leads-drawer.tsx");

    expect(board).toContain('const DRAWER_MEASURE = "kapso:lead-drawer-open"');
    expect(board).toContain("onReady={measureLeadDrawerReady}");
    expect(drawer).toContain("export function LeadDrawer(");
    expect(drawer).toContain("function WhatsappChat(");
    expect(drawer).toContain("function OrderFormPanel(");
    expect(drawer).toContain("function CallForm(");
  });
});
