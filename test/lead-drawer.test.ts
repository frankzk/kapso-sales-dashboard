import { describe, expect, it } from "vitest";
import { MAX_DRAWER_CONVERSATIONS, drawerConversationIds } from "@/lib/lead-drawer";

describe("drawerConversationIds", () => {
  it("keeps the first drawer paint to the active session", () => {
    expect(drawerConversationIds("active", ["active", "older-1", "older-2"], false)).toEqual(["active"]);
  });

  it("hydrates older sessions in the background without duplicates or unbounded fan-out", () => {
    const ids = drawerConversationIds(
      "active",
      ["active", ...Array.from({ length: 15 }, (_, index) => `older-${index}`)],
      true,
    );
    expect(ids[0]).toBe("active");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(MAX_DRAWER_CONVERSATIONS);
  });
});
