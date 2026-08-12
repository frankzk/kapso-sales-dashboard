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

describe("el nombre que el voucher corta no es un receptor distinto", () => {
  // Los nombres reales que estaban parados en revisión administrativa: Yape y
  // la app de BCP truncan el destinatario por ancho de pantalla, y exigir el
  // sufijo S.A.C. los acusaba de desvío de dinero.
  it("acepta como lectura corta las variantes vistas en producción", () => {
    for (const leido of ["Grupo Gf S", "Grupo gf s", "Grupo Gf S.", "Grupo GF", "Grupo G***"]) {
      const v = verifyYapeRecipient(leido, null);
      expect({ leido, status: v.status, cut: v.nameCutShort }).toEqual({
        leido,
        status: "partial",
        cut: true,
      });
    }
  });

  it("una lectura corta NO verifica la cuenta, solo deja de acusarla", () => {
    // Que empiece igual no prueba nada; el operador tiene que mirar la imagen.
    expect(verifyYapeRecipient("Grupo Gf S", null).nameMatches).toBe(false);
    expect(verifyYapeRecipient("Grupo Gf S", "309").status).toBe("partial");
  });

  it("el nombre completo sigue verificando como antes", () => {
    for (const leido of ["Grupo Gf S.a.c.", "GRUPO GF S A C", "Grupo GF S.A.C."]) {
      expect(verifyYapeRecipient(leido, "309")).toMatchObject({
        status: "verified",
        nameMatches: true,
        nameCutShort: false,
      });
    }
  });

  it("un receptor de verdad distinto sigue siendo mismatch", () => {
    // Estos también estaban en los datos, y son los que la alarma existe para
    // cazar. Si el recorte los tapara, el arreglo habría salido caro.
    for (const leido of [
      "Gabriela Reaño Vera",
      "Gabriela Rea*",
      "WAYKI - ADOLFO MIGUEL ERNESTO EGUILUZ OCHOA",
      "Elizabeth Sua*",
      "BCP",
      "Grupo Rodriguez",
      "Gf S.a.c.",
    ]) {
      expect({ leido, status: verifyYapeRecipient(leido, null).status }).toEqual({
        leido,
        status: "mismatch",
      });
    }
  });

  it("una sola palabra no basta para llamarlo lectura corta", () => {
    // "Grupo" a secas no distingue Grupo GF de Grupo cualquier-otra-cosa.
    expect(verifyYapeRecipient("Grupo", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("G", null).status).toBe("mismatch");
  });

  it("el celular leído sigue siendo tajante, aunque el nombre venga cortado", () => {
    // La lectura corta perdona el nombre, no la otra señal: 123 no es 309.
    expect(verifyYapeRecipient("Grupo Gf S", "123").status).toBe("mismatch");
  });

  it("el recorte se lee desde el principio y en orden, no a trozos", () => {
    // Un recorte conserva el comienzo. Nada de esto lo es.
    expect(verifyYapeRecipient("Gf Grupo", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo Gf S A X Y", null).status).toBe("mismatch");
    expect(verifyYapeRecipient("Grupo Rf S", null).status).toBe("mismatch");
  });

  it("KP127475: el caso que lo destapó queda en partial, no en «receptor distinto»", () => {
    expect(
      yapeRecipientReadingFromVision({
        extracted: { recipient_name: "Grupo Gf S", recipient_phone_last_digits: null },
      }),
    ).toEqual({ name: "Grupo Gf S", phoneLastDigits: null, status: "partial" });
  });
});
