// La cola de Leads pregunta por su firma cada 60 s (decisión del owner,
// 15-11-2026; MOM «Bloques por asesora»): cada pregunta es la cola entera de
// `lead_routing_scope`, la consulta que más tiempo de base gasta. Se fija el
// intervalo, que la pestaña oculta no pregunte y que al volver pregunte ya.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const leads = read("components/leads.tsx");

describe("el sondeo de la cola de Leads", () => {
  it("pregunta cada 60 s", () => {
    expect(leads).toContain("const LEADS_LIVE_POLL_MS = 60_000;");
    expect(leads).toContain("setInterval(() => void check(), LEADS_LIVE_POLL_MS)");
  });

  it("la pestaña oculta no pregunta y al volver pregunta en el acto", () => {
    expect(leads).toContain("if (!alive || document.hidden || inFlight) return;");
    expect(leads).toMatch(/const onVisible = \(\) => \{\s*if \(!document\.hidden\) void check\(\);/);
  });

  it("el MOM lo registra", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**La cola de Leads se revisa cada 60 s (15-11-2026, decisión del owner).**");
    expect(mom).toContain("aparece en hasta un minuto en vez de 30 s");
  });
});
