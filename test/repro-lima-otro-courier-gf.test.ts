// Owner, 24-11-2026 (#KP207918, #KP200821): «cuando se ejecuta la reprogramación para otro día, donde la guía se va a
// generar ese día posterior, no se anula la guía de GF Courier… ni tampoco lo pasó al flujo del día: programados».
// Quien guarda el acuerdo con otro courier decide: Kapta anula al guardar la guía GF sin motorizado y el caso conserva
// su acuerdo en el episodio de la etapa (no se cierra como «nuevo intento»), así queda en Programados.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gfOtherCourierNote, reproGfOtherCourierNote, reproGfOtherCourierReason } from "@/lib/repro-lima";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("acuerdo con otro courier y una guía GF viva", () => {
  it("la hoja dice que Kapta la anula al guardar, o que no puede si ya tiene motorizado", () => {
    expect(gfOtherCourierNote({ kind: "crear" }, "Swayp")).toBeNull();
    expect(gfOtherCourierNote({ kind: "reemplazar", cancel: [{ guideCode: "KENKU-KP207918-S2" }] }, "Swayp"))
      .toBe("Al guardar, Kapta anula la guía KENKU-KP207918-S2 (GF todavía no la asigna a un motorizado): sale con Swayp.");
    expect(gfOtherCourierNote({ kind: "lista", guideCode: "KENKU-KP1" }, "Aliclik")).toContain("Kapta anula la guía KENKU-KP1");
    expect(gfOtherCourierNote({ kind: "asignada", guideCode: "KENKU-KP1" }, "Aliclik"))
      .toBe("GF Courier ya asignó la guía KENKU-KP1 a un motorizado: Kapta no la anula. Pide a GF que la devuelva antes de que salga con Aliclik.");
  });

  it("el motivo y la nota de la anulación nombran el courier y el día", () => {
    expect(reproGfOtherCourierReason("Swayp")).toBe("Nuevo acuerdo en Repro Lima: sale con Swayp");
    expect(reproGfOtherCourierNote("Aliclik", "2026-11-25")).toBe("Guía de GF Courier anulada por Kapta: la clienta acordó salir con Aliclik el mié 25/11 en Repro Lima.");
  });

  const actions = read("app/dashboard/pedidos/repro-lima/actions.ts");
  const release = actions.slice(actions.indexOf("async function releaseGfForAgreement("), actions.indexOf("/**\n * Lo que sigue a cada resultado (E23):"));

  it("al guardar, anula la guía GF sin motorizado; con motorizado, lo dice sin anular", () => {
    expect(release).toContain("const live = f.outputs.filter(isLiveGfGuide);");
    expect(release.indexOf('output.delivery_status === "en_ruta"')).toBeLessThan(release.indexOf("cancelGfGuideFor("));
    expect(release).toContain("reason: reproGfOtherCourierReason(courierName),");
    expect(release).toContain("if (res.requested) return { note: \"\", error: gfCancelRequestedText(output.guide_code) };");
    expect(release).toContain("await recomputeOrderMasterSafe(admin, [f.orderId]);");
  });

  it("el caso de la atención pasa a la etapa con su acuerdo, sin pisar a otro", () => {
    expect(release).toContain('if (c.episode_key.startsWith("attention:")) {');
    expect(release).toContain("if (fresh?.inStage && fresh.episode.key !== c.episode_key) {");
    expect(release).toContain('.eq("id", c.id).is("closed_at", null).eq("episode_key", c.episode_key);');
  });

  it("va en el camino «otro courier», antes de «la salida ya existe» y de la guía del día programado", () => {
    const branch = actions.slice(actions.indexOf('case "otro_courier":'), actions.indexOf('case "falta_salida": {'));
    const at = branch.indexOf("await releaseGfForAgreement(admin, { facts: f, caseRow: c, day, courierName, actor });");
    expect(at).toBeGreaterThan(branch.indexOf('if (courier === "gf_courier") {'));
    expect(at).toBeLessThan(branch.indexOf("la salida de ${courierName} ya existe"));
    expect(at).toBeLessThan(branch.indexOf("loadLimaCourierAutoActiveStores("));
    expect(branch).toContain('${gf.error ? "" : " (en «Programados»)"}');
  });

  it("la hoja lo avisa con cualquier courier que no sea GF Courier", () => {
    const panel = read("components/repro-lima-panel.tsx");
    expect(panel).toContain('courier === "gf_courier" ? gfAgreementGuideNote(current.gfGuidePlan) : gfOtherCourierNote(current.gfGuidePlan, reproCourierName(courier))');
  });
});
