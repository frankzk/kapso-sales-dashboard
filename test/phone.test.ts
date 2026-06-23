import { describe, it, expect } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it("strips non-digit characters", () => {
    expect(normalizePhone("+51 980 694 766")).toBe("51980694766");
  });
  it("adds the Peru country code to a bare 9-digit mobile", () => {
    expect(normalizePhone("980694766")).toBe("51980694766");
  });
  it("drops a leading 00 international prefix", () => {
    expect(normalizePhone("0051980694766")).toBe("51980694766");
  });
  it("leaves an already-normalized number unchanged", () => {
    expect(normalizePhone("51980694766")).toBe("51980694766");
  });
  it("returns null for empty / non-numeric input", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});
