import { describe, expect, it } from "vitest";
import { cameraErrorMessage, classifyCameraError } from "@/lib/camera-error";

const err = (name: string) => Object.assign(new Error("x"), { name });

describe("classifyCameraError", () => {
  it("fuera de HTTPS lo dice antes de culpar al permiso", () => {
    expect(classifyCameraError(err("NotAllowedError"), false)).toBe("insecure");
  });

  it("bloqueo del navegador: a mano o por Permissions-Policy", () => {
    expect(classifyCameraError(err("NotAllowedError"))).toBe("denied");
    expect(classifyCameraError(err("SecurityError"))).toBe("denied");
  });

  it("sin cámara en el equipo", () => {
    expect(classifyCameraError(err("NotFoundError"))).toBe("not_found");
    expect(classifyCameraError(err("OverconstrainedError"))).toBe("not_found");
  });

  it("cámara tomada por otra app", () => {
    expect(classifyCameraError(err("NotReadableError"))).toBe("in_use");
    expect(classifyCameraError(err("AbortError"))).toBe("in_use");
  });

  it("lo que no reconocemos queda como desconocido, no como permiso", () => {
    expect(classifyCameraError(err("RaroError"))).toBe("unknown");
    expect(classifyCameraError(null)).toBe("unknown");
    expect(classifyCameraError("un string")).toBe("unknown");
  });
});

describe("cameraErrorMessage", () => {
  it("el bloqueo manda al candado del navegador, no a los ajustes del teléfono", () => {
    const msg = cameraErrorMessage(err("NotAllowedError"));
    expect(msg).toContain("candado");
    expect(msg).toContain("campo manual");
  });

  it("un error desconocido conserva su nombre técnico a la vista", () => {
    // Un mensaje genérico fue lo que ocultó durante días que la causa era un
    // header nuestro. Si no sabemos qué pasó, que al menos se pueda reportar.
    expect(cameraErrorMessage(err("RaroError"))).toContain("(RaroError)");
  });

  it("sin nombre no inventa paréntesis vacíos", () => {
    expect(cameraErrorMessage(null)).not.toContain("(");
  });

  it("cada causa da una instrucción distinta", () => {
    const msgs = [
      cameraErrorMessage(err("NotAllowedError")),
      cameraErrorMessage(err("NotFoundError")),
      cameraErrorMessage(err("NotReadableError")),
      cameraErrorMessage(err("NotAllowedError"), false),
    ];
    expect(new Set(msgs).size).toBe(msgs.length);
  });
});
