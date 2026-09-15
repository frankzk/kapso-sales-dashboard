import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_TTL_MINUTES, activeClaimHolders } from "@/lib/leads";

/**
 * La etiqueta «Tomado» dice por quién.
 *
 * Antes la fila solo sabía el HECHO (un id en `claimed_by`) y la asesora tenía
 * que abrir el lead —y chocar con el aviso— para enterarse de a quién
 * preguntarle. Ahora la página resuelve el nombre de quienes tienen reservas
 * vivas y la cola lo muestra al lado del candado.
 */

const now = new Date("2026-09-14T15:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe("activeClaimHolders: a quién hay que ponerle nombre", () => {
  it("devuelve cada asesora con reserva viva una sola vez", () => {
    const ids = activeClaimHolders(
      [
        { claimed_by: "rosa", claimed_at: minutesAgo(1) },
        { claimed_by: "rosa", claimed_at: minutesAgo(3) },
        { claimed_by: "ana", claimed_at: minutesAgo(5) },
      ],
      now,
    );
    expect(ids.sort()).toEqual(["ana", "rosa"]);
  });

  it("una reserva vencida no cuenta: la fila tampoco la marca como tomada", () => {
    const ids = activeClaimHolders(
      [
        { claimed_by: "rosa", claimed_at: minutesAgo(CLAIM_TTL_MINUTES + 1) },
        { claimed_by: "ana", claimed_at: minutesAgo(CLAIM_TTL_MINUTES - 1) },
      ],
      now,
    );
    expect(ids).toEqual(["ana"]);
  });

  it("sin reserva (o sin fecha) no hay a quién resolver", () => {
    expect(
      activeClaimHolders(
        [
          { claimed_by: null, claimed_at: null },
          { claimed_by: "rosa", claimed_at: null },
        ],
        now,
      ),
    ).toEqual([]);
  });
});

describe("la cola y la página están cableadas", () => {
  const ui = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");
  const page = readFileSync(resolve(process.cwd(), "app/dashboard/leads/page.tsx"), "utf8");

  it("la página resuelve solo a quienes tienen reserva viva y se lo pasa al tablero", () => {
    expect(page).toContain("resolveAgentNames(activeClaimHolders(rows))");
    expect(page).toContain("agentNames={agentNames}");
  });

  it("la etiqueta muestra el nombre y el título dice quién atiende", () => {
    expect(ui).toContain("const lockedBy = locked ? (agentNames?.[lead.claimed_by!] ?? null) : null;");
    expect(ui).toContain("`${lockedBy} está atendiendo este lead`");
    expect(ui).toContain('<span className="truncate font-medium">{lockedBy}</span>');
  });

  it("sin nombre vuelve a decir solo «Tomado», nunca un id", () => {
    const badge = ui.slice(ui.indexOf("{locked && ("), ui.indexOf("{locked && (") + 1200);
    expect(badge).toContain("{lockedBy && (");
    expect(badge).not.toContain("claimed_by.slice");
  });
});

describe("un solo resolutor de nombres para todo el panel", () => {
  it("Leads y Envíos importan el compartido y ya no tienen copia propia", () => {
    for (const file of ["app/dashboard/leads/actions.ts", "app/dashboard/envios/actions.ts"]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src).toContain('from "@/lib/agent-names"');
      expect(src).not.toContain("const agentNameCache");
      expect(src).not.toContain("async function resolveAgentName(");
    }
  });
});
