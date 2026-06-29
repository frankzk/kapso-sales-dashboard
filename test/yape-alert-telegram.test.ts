import { describe, it, expect } from "vitest";
import {
  formatUnattendedYapeAlert,
  selectUnattendedYapes,
  type UnattendedYapeRow,
} from "@/lib/yape-alert-telegram";

const NOW = 1_000_000_000;
const MIN = 60_000;
const row = (id: string, over: Partial<UnattendedYapeRow> = {}): UnattendedYapeRow => ({
  id,
  name: `Cliente ${id}`,
  phone: `5199${id}`,
  waitingSinceMs: NOW - 20 * MIN, // waiting 20 min (past the 10-min threshold)
  claimedFresh: false,
  alertSentAtMs: null,
  ...over,
});

describe("selectUnattendedYapes", () => {
  it("alerts a pending Yape past the threshold that was never alerted", () => {
    expect(selectUnattendedYapes([row("1")], NOW).map((r) => r.id)).toEqual(["1"]);
  });

  it("ignores a Yape someone is already handling (fresh claim)", () => {
    expect(selectUnattendedYapes([row("1", { claimedFresh: true })], NOW)).toEqual([]);
  });

  it("ignores a Yape still within the pending threshold", () => {
    expect(selectUnattendedYapes([row("1", { waitingSinceMs: NOW - 5 * MIN })], NOW)).toEqual([]);
  });

  it("dedups: skips one alerted recently, re-alerts one alerted long ago", () => {
    const recent = row("recent", { alertSentAtMs: NOW - 30 * MIN }); // <3h → skip
    const old = row("old", { alertSentAtMs: NOW - 200 * MIN }); // >3h → re-alert
    expect(selectUnattendedYapes([recent, old], NOW).map((r) => r.id)).toEqual(["old"]);
  });
});

describe("formatUnattendedYapeAlert", () => {
  it("lists the unattended Yapes with name, phone and wait time", () => {
    const msg = formatUnattendedYapeAlert("Aurela", [row("1")], NOW);
    expect(msg).toContain("Aurela");
    expect(msg).toContain("1 Yape/Shalom sin atender");
    expect(msg).toContain("Cliente 1");
    expect(msg).toContain("+51991");
    expect(msg).toMatch(/hace \d+ min/);
  });
});
