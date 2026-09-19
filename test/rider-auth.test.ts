// Acceso de motorizados con usuario y contraseña (docs/runbooks/motorizados-acceso.md).
import { describe, expect, it } from "vitest";
import {
  RIDER_EMAIL_DOMAIN,
  friendlyPasswordError,
  generateRiderPassword,
  isRiderInternalEmail,
  riderEmailToUsername,
  riderUsernameToEmail,
} from "@/lib/rider-auth";

describe("riderUsernameToEmail", () => {
  it("convierte el usuario corto al correo interno, en minúsculas y sin espacios", () => {
    expect(riderUsernameToEmail("roy")).toBe(`roy@${RIDER_EMAIL_DOMAIN}`);
    expect(riderUsernameToEmail("  Roy ")).toBe(`roy@${RIDER_EMAIL_DOMAIN}`);
    expect(riderUsernameToEmail("yhoni.r")).toBe(`yhoni.r@${RIDER_EMAIL_DOMAIN}`);
  });

  it("respeta un correo real y rechaza lo que no es usuario ni correo", () => {
    expect(riderUsernameToEmail("Roy@Gmail.com")).toBe("roy@gmail.com");
    expect(riderUsernameToEmail("")).toBeNull();
    expect(riderUsernameToEmail("r")).toBeNull();
    expect(riderUsernameToEmail("roy perez")).toBeNull();
    expect(riderUsernameToEmail("roy@")).toBeNull();
  });

  it("vuelve del correo interno al usuario, y deja un correo real entero", () => {
    expect(riderEmailToUsername(`roy@${RIDER_EMAIL_DOMAIN}`)).toBe("roy");
    expect(riderEmailToUsername("roy@gmail.com")).toBe("roy@gmail.com");
    expect(isRiderInternalEmail(`roy@${RIDER_EMAIL_DOMAIN}`)).toBe(true);
    expect(isRiderInternalEmail("roy@gmail.com")).toBe(false);
    expect(isRiderInternalEmail(null)).toBe(false);
  });
});

describe("generateRiderPassword", () => {
  it("tiene 10 caracteres legibles con minúscula, mayúscula y dígito", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateRiderPassword();
      expect(p).toHaveLength(10);
      expect(p).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
    }
  });

  it("nunca usa caracteres que se confunden al dictar (0, O, 1, l, I)", () => {
    const p = generateRiderPassword(200);
    expect(p).not.toMatch(/[0O1lI]/);
  });

  it("con un generador degenerado igual cumple la política mínima", () => {
    const p = generateRiderPassword(10, () => 0);
    expect(p).toHaveLength(10);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/\d/);
  });

  it("rechaza longitudes absurdas", () => {
    expect(() => generateRiderPassword(3)).toThrow();
  });
});

describe("friendlyPasswordError", () => {
  it("traduce los errores de Supabase a algo que un motorizado entiende", () => {
    expect(friendlyPasswordError("Invalid login credentials")).toMatch(/Usuario o contraseña incorrectos/);
    expect(friendlyPasswordError("Email not confirmed")).toMatch(/no está activado/);
    expect(friendlyPasswordError("User is banned")).toMatch(/desactivado/);
    expect(friendlyPasswordError("Request rate limit reached")).toMatch(/Demasiados intentos/);
    expect(friendlyPasswordError("otra cosa")).toBe("otra cosa");
  });
});
