import { describe, expect, it } from "vitest";
import {
  verifyYapeRecipient,
  yapeRecipientReadingFromVision,
} from "@/lib/yape-recipient";

describe("verificación de la cuenta receptora Yape", () => {
  it("verifica Grupo GF S.A.C. con el celular completo", () => {
    expect(verifyYapeRecipient("GRUPO GF S.A.C.", "930 555 309")).toMatchObject({
      status: "verified",
      nameMatches: true,
      phoneMatches: true,
    });
  });

  it("acepta una lectura segura de los últimos tres dígitos", () => {
    expect(verifyYapeRecipient("Grupo GF SAC", "***309").status).toBe("verified");
  });

  it("distingue señal parcial de una cuenta distinta", () => {
    expect(verifyYapeRecipient("Grupo GF SAC", null).status).toBe("partial");
    expect(verifyYapeRecipient(null, "309").status).toBe("partial");
    expect(verifyYapeRecipient("Otro negocio", "309").status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo GF SAC", "123").status).toBe("mismatch");
  });

  it("recalcula el estado desde la auditoría y no confía en una marca guardada", () => {
    expect(
      yapeRecipientReadingFromVision({
        extracted: {
          recipient_name: "Otro negocio",
          recipient_phone_last_digits: "309",
          recipient_check: "verified",
        },
      }),
    ).toEqual({ name: "Otro negocio", phoneLastDigits: "309", status: "mismatch" });
  });
});
