import { describe, expect, it } from "vitest";
import { cleanDiag, cleanDiagValue } from "@/lib/anura/phone-diag";

describe("diagnóstico del teléfono de Kapta (sin datos personales)", () => {
  it("borra cualquier secuencia de 6+ dígitos (un teléfono nunca llega al log)", () => {
    expect(cleanDiagValue("sip:965391481@central.anura.pe")).toBe("sip:#@central.anura.pe");
    expect(cleanDiagValue("+51 965391481")).toBe("+51 #");
    expect(cleanDiagValue(486)).toBe(486);
    expect(cleanDiagValue(undefined)).toBeNull();
  });

  it("acorta textos y limpia nombres de evento y claves", () => {
    expect(String(cleanDiagValue("x".repeat(200))).length).toBe(80);
    expect(cleanDiag("invite!", { "why;": "no_remoto", ok: true })).toEqual({ event: "invite", data: { why: "no_remoto", ok: true } });
    expect(cleanDiag("", {})).toBeNull();
    expect(cleanDiag(42, {})).toBeNull();
  });
});
