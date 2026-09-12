import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Envíos se puede trabajar sin ratón y sin ver el color.
 *
 * Audit del 12-09-2026 (10/20): la acción primaria era un `<tr onClick>` sin
 * teclado, el cajón no era un diálogo (sin rol, sin Escape, el foco se quedaba
 * detrás), 2 de 36 controles declaraban foco, los `<select>` de disposición y
 * las notas no tenían nombre, y el texto secundario iba en `slate-400`
 * (2,97:1). PRODUCT.md fija WCAG 2.1 AA.
 */

const src = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

function between(start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  expect(i, start).toBeGreaterThan(-1);
  expect(j, end).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("abrir una guía con el teclado", () => {
  it("el código de la guía es un botón dentro de la fila", () => {
    const row = between("{shownRows.map((s) => (", "{s.courier === \"fenix\" && (");
    expect(row).toContain('<button\n                  type="button"');
    expect(row).toContain("onOpen(s.id);");
    expect(row).toContain("e.stopPropagation();");
    expect(row).toContain("{s.guide_code}\n                </button>");
  });
});

describe("el cajón y el modal son diálogos", () => {
  it("rol, título enlazado, foco al abrir, Escape para cerrar y foco de vuelta", () => {
    for (const id of ["shipment-drawer-title", "reprogram-modal-title"]) {
      expect(src).toContain(`aria-labelledby="${id}"`);
      expect(src).toContain(`id="${id}"`);
    }
    expect(src.match(/role="dialog"/g)?.length).toBe(2);
    expect(src.match(/aria-modal="true"/g)?.length).toBe(2);
    // Una sola función para los dos diálogos (`useDialogKeys`): el foco entra,
    // Escape cierra, Tab no se escapa y al cerrar el foco vuelve.
    expect(src).toContain("function useDialogKeys(");
    expect(src).toContain("panelRef.current?.focus();");
    expect(src).toContain('if (e.key === "Escape") {');
    expect(src).toContain("opener?.focus();");
    expect(src.match(/useDialogKeys\(panelRef, /g)?.length).toBe(2);
  });

  it("el foco no se escapa al tablero de atrás", () => {
    const hook = between("function useDialogKeys(", "const SIN_DISTRITO");
    expect(hook).toContain('if (e.key !== "Tab") return;');
    expect(hook).toContain("panel.querySelectorAll<HTMLElement>(");
    expect(hook).toContain("first.focus();");
    expect(hook).toContain("last.focus();");
  });

  it("Escape cierra por la misma puerta que el botón «Cerrar» (suelta la reserva)", () => {
    expect(src).toContain("closeRef.current = handleClose;");
  });
});

describe("cada control tiene nombre", () => {
  it("búsqueda, «✕» y los selects/notas de llamada", () => {
    expect(src).toContain('aria-label="Buscar guía, pedido, guía Swayp o celular"');
    expect(src).toContain('aria-label="Limpiar búsqueda"');
    expect(src).toContain('aria-label="Cerrar"');
    // Los dos <select> de disposición y las dos notas van dentro de un <label>.
    expect(src.match(/Resultado de la llamada\n\s+<select/g)?.length).toBe(2);
    // Ningún <select> ni <textarea> queda suelto: cada uno va dentro de un
    // <label> (la etiqueta lo precede a pocas líneas) o lleva aria-label.
    for (const tag of ["<select", "<textarea"]) {
      for (const m of src.matchAll(new RegExp(tag, "g"))) {
        const at = m.index!;
        const before = src.slice(Math.max(0, at - 520), at);
        const after = src.slice(at, at + 400);
        const line = src.slice(0, at).split("\n").length;
        expect(/<label/.test(before) || /aria-label=/.test(after), `${tag} en línea ${line}`).toBe(true);
      }
    }
  });
});

describe("foco visible y contraste", () => {
  it("el anillo de foco es global, de la paleta, y no se pinta al hacer clic", () => {
    expect(css).toContain(":where(a, button, input, select, textarea, summary, [tabindex]):focus-visible");
    expect(css).toContain("outline: 2px solid var(--color-brand-500);");
  });

  it("el texto secundario ya no baja de slate-500 (4,5:1 sobre slate-50)", () => {
    expect(src).not.toContain("text-slate-400");
  });

  it("el punto que pulsa respeta movimiento reducido", () => {
    expect(src).toContain("animate-pulse bg-slate-400 motion-reduce:animate-none");
  });
});

describe("títulos de sección semánticos", () => {
  it("las secciones del cajón se anuncian como h3, no como párrafos en negrita", () => {
    for (const title of [
      "Destino de entrega",
      "Registrar o programar llamada",
      "Continúa en la guía Swayp activa",
      "Registrar resultado del courier",
      "Guía Swayp (antes Fénix) a mano",
      "Historial desde el origen",
    ]) {
      expect(src, title).toMatch(new RegExp(`<h3[^>]*>${title.replace(/[()]/g, "\\$&")}</h3>`));
    }
  });
});
