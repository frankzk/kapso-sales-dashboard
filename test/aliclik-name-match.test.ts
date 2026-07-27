import { describe, it, expect } from "vitest";
import { normalizeProductName } from "@/lib/aliclik-catalog";

// Pares reales: izquierda = título en Shopify (de la base de producción),
// derecha = el mismo producto tal y como aparece en el panel de Aliclik.
const PAIRS: [string, string][] = [
  [
    "FEEL VIRGIN – Gel Íntimo Reafirmante e Hidratante con Aloe Vera y Ácido Hialurónico (30 mL)",
    "FEEL VIRGIN – Gel Íntimo Reafirmante e Hidratante con Aloe Vera y Ácido Hialurónico (30 mL) - AUR5X",
  ],
  [
    "Keratina + Romero + Ortiga + Biotina - Champú Nutritivo y Regenerador para Cabello Grueso y Voluminoso (220 ml) - IdeasLabCo™",
    "Keratina + Romero + Ortiga + Biotina - Champú Nutritivo y Regenerador para Cabello Grueso y Voluminoso (220 ml) - IdeasLabCo™ - AUR5X",
  ],
  [
    "Mushroom Coffee - Café Instantáneo con 6 Hongos Funcionales Súper Alimentos (180 Gramos / 30 Porciones) - SuperHuman™",
    "Mushroom Coffee - Café Instantáneo con 6 Hongos Funcionales Súper Alimentos (180 Gramos / 30 Porciones) - SuperHuman™ - AUR5X",
  ],
  [
    "Espátula con Mango de Madera para Parrilla y Cocina",
    "Espátula con Mango de Madera para Parrilla y Cocina - AUR5X",
  ],
  [
    "FlexiNap™-Almohada de viaje ergonómica de felpa azul, rellenable con ropa para mayor comodidad y practicidad.",
    "FlexiNap™-Almohada de viaje ergonómica de felpa azul, rellenable con ropa para mayor comodidad y practicidad. - AUR5X",
  ],
];

describe("normalizeProductName contra títulos reales", () => {
  it.each(PAIRS)("empareja %s", (shopify, aliclik) => {
    expect(normalizeProductName(shopify)).toBe(normalizeProductName(aliclik));
  });

  it("NO empareja productos distintos que se parecen", () => {
    // Dos presentaciones del mismo producto son productos DISTINTOS.
    expect(normalizeProductName("Vitamina D3 + K2 (300 Cápsulas) - AUR5X")).not.toBe(
      normalizeProductName("Vitamina D3 + K2 (120 Cápsulas) - AUR5X"),
    );
    expect(normalizeProductName("Pulsera Magnética de Cobre Saludable Cooper+")).not.toBe(
      normalizeProductName("Crucis+ Pulsera Magnética de Cobre de Alivio y Bienestar Espiritual"),
    );
  });

  it("no se come un guion que sí es parte del nombre", () => {
    // "- AUR5X" solo se quita al FINAL.
    expect(normalizeProductName("Nails Repairing - Sérum Tea Tree - AUR5X")).toBe(
      "nails repairing - serum tea tree",
    );
  });

  it("tolera vacíos", () => {
    expect(normalizeProductName(null)).toBe("");
    expect(normalizeProductName("   ")).toBe("");
  });
});
