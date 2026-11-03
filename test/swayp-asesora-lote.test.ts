// La asesora en la puerta «Guía Swayp directa» (MOM §9.1 «Swayp por salir ·
// Lima» y §11.6.1; D1 y D3 del owner, 03-11-2026). Con destino de Lima o Callao
// la caja la arma nuestro almacén, así que la puerta dice a qué lote del
// almacén entra la guía y, pasado el corte del turno noche de la víspera
// (21:20), avisa fuerte y propone el siguiente día de despacho. Nada bloquea;
// provincia no cambia.
//
// Las frases y las horas salen de `swaypLotNotice` y `swaypSuggestedDispatchDay`
// (lib/warehouse-swayp.ts, probadas también en test/warehouse-swayp.test.ts):
// aquí, los casos de la puerta y que el modal y el servidor las usen así.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  swaypDayLabel,
  swaypLotNotice,
  swaypSuggestedDispatchDay,
  SWAYP_ASESORA_CREATED,
  SWAYP_ASESORA_NOCHE,
  SWAYP_ASESORA_TARDE,
} from "@/lib/warehouse-swayp";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Un instante de Lima (UTC−5 todo el año). */
const lima = (day: string, time: string) => new Date(`${day}T${time}:00-05:00`);

/** El cuerpo de una función o bloque del fuente, desde su firma hasta la siguiente al mismo nivel. */
function body(src: string, signature: string, until: RegExp = /\n(?:export )?(?:async )?function |\n {2}const [a-zA-Z]+ = /): string {
  const start = src.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const next = rest.search(until);
  return signature + (next === -1 ? rest : rest.slice(0, next));
}

describe("lo que la puerta le dice a la asesora (miércoles 4 nov, víspera el martes 3)", () => {
  const WED = "2026-11-04";
  const created = SWAYP_ASESORA_CREATED(swaypDayLabel(WED));

  it("antes de las 17:00 de la víspera: a qué lote entró, sin más", () => {
    expect(created).toBe("Entró al lote Swayp de Lima del miércoles 4 nov. Almacén lo ve en «Swayp por salir».");
    // KP143987-S02: creada el martes 3 nov a las 00:11, para el miércoles.
    expect(swaypLotNotice({ day: WED, now: lima("2026-11-03", "00:11"), lima: true })).toEqual({
      before: null,
      after: created,
      late: false,
      afterCutoff: false,
    });
    expect(swaypLotNotice({ day: WED, now: lima("2026-11-03", "17:00"), lima: true })?.late).toBe(false);
  });

  it("de 17:00 a 21:20: el aviso suave, que el almacén la verá como agregada tarde", () => {
    const notice = swaypLotNotice({ day: WED, now: lima("2026-11-03", "20:43"), lima: true })!;
    expect(notice).toEqual({ before: null, after: `${created} ${SWAYP_ASESORA_TARDE}`, late: true, afterCutoff: false });
    expect(swaypLotNotice({ day: WED, now: lima("2026-11-03", "21:19"), lima: true })?.afterCutoff).toBe(false);
  });

  it("desde las 21:20: el aviso fuerte bajo la fecha y al crear, y la puerta propone el jueves", () => {
    for (const time of ["21:20", "23:59"]) {
      const notice = swaypLotNotice({ day: WED, now: lima("2026-11-03", time), lima: true })!;
      expect(notice.before).toEqual({ kind: "crit", text: SWAYP_ASESORA_NOCHE });
      expect(notice.after).toBe(`${created} ${SWAYP_ASESORA_NOCHE}`);
      expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", time), lima: true })).toBe("2026-11-05");
    }
    // Elegir el jueves apaga el aviso de antes de crear: no es el próximo día de despacho.
    expect(swaypLotNotice({ day: "2026-11-05", now: lima("2026-11-03", "22:00"), lima: true })?.before).toBeNull();
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", "21:19"), lima: true })).toBe(WED);
  });

  it("el lunes lo arma el turno noche del domingo (D5): el sábado no avisa, el domingo a las 21:20 sí", () => {
    const MON = "2026-11-09";
    expect(swaypLotNotice({ day: MON, now: lima("2026-11-07", "22:00"), lima: true })).toMatchObject({ before: null, late: false });
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-07", "22:00"), lima: true })).toBe(MON);
    expect(swaypLotNotice({ day: MON, now: lima("2026-11-08", "21:20"), lima: true })?.before?.text).toBe(SWAYP_ASESORA_NOCHE);
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-08", "21:20"), lima: true })).toBe("2026-11-10");
  });

  it("provincia no cambia: ni aviso ni otra fecha propuesta", () => {
    expect(swaypLotNotice({ day: WED, now: lima("2026-11-03", "22:00"), lima: false })).toBeNull();
    expect(swaypSuggestedDispatchDay({ now: lima("2026-11-03", "22:00"), lima: false })).toBe(WED);
  });
});

describe("el modal usa esas reglas (components/direct-fenix-guide-modal.tsx)", () => {
  const modal = read("components/direct-fenix-guide-modal.tsx");

  it("las frases salen de lib/warehouse-swayp.ts, no se escriben aquí", () => {
    expect(modal).toContain('import { swaypLotNotice, swaypSuggestedDispatchDay, type SwaypLotNotice } from "@/lib/warehouse-swayp";');
    expect(modal).not.toContain("Entró al lote");
    expect(modal).not.toContain("agregada tarde");
    expect(modal).not.toContain("pasada la medianoche");
  });

  it("Lima con certeza: la operación del pedido, la misma del lote del almacén, no la ciudad", () => {
    expect(modal).toContain('const limaLot = preview?.operation === "lima";');
    expect(modal).not.toMatch(/city\s*===\s*"(lima|callao)"/);
    expect(modal).toContain('swaypSuggestedDispatchDay({ now, lima: p.operation === "lima" })');
  });

  it("la hora se lee en el navegador al cargar el pedido, al elegir la fecha y al confirmar; nunca al pintar", () => {
    expect(modal).toContain("const [clock, setClock] = useState<Date | null>(null);");
    const loaded = body(modal, "function onPreviewLoaded(");
    expect(loaded).toContain("const now = new Date();");
    expect(loaded).toContain("setClock(now);");
    // La fecha propuesta no pisa la que la persona ya eligió.
    expect(loaded).toContain("if (!dateTouched.current) setDispatchDate(");
    // Las dos cargas del pedido (desde el Master y desde la búsqueda) pasan por ahí.
    expect(modal.match(/onPreviewLoaded\((result|r)\);/g)).toHaveLength(2);
    const select = modal.slice(modal.indexOf("<SwaypDispatchDateSelect"), modal.indexOf("/>", modal.indexOf("<SwaypDispatchDateSelect")));
    expect(select).toContain("dateTouched.current = true;");
    expect(select).toContain("setClock(new Date());");
    const create = body(modal, "function create(");
    expect(create).toContain("setCreatedLot(swaypLotNotice({ day: dispatchDate, now: new Date(), lima: limaLot }));");
    // Solo después de crear con éxito.
    expect(create.indexOf("setCreatedLot(")).toBeGreaterThan(create.indexOf("if (r.error)"));
  });

  it("el aviso fuerte va bajo la fecha, y es un aviso: no pinta el campo ni apaga el botón", () => {
    expect(modal).toContain("const lotBefore = clock && limaLot ? swaypLotNotice({ day: dispatchDate, now: clock, lima: true })?.before ?? null : null;");
    const dateAt = modal.indexOf("<SwaypDispatchDateSelect");
    const hintAt = modal.indexOf("{lotBefore.text}");
    expect(hintAt).toBeGreaterThan(dateAt);
    expect(hintAt).toBeLessThan(modal.indexOf("N° de guía Swayp", dateAt));
    const select = modal.slice(dateAt, modal.indexOf("/>", dateAt));
    expect(select).not.toContain("invalid");
    expect(select).not.toContain("ring-crit");
    // Nada bloquea (D3): `canCreate` no mira el aviso.
    const canCreate = modal.slice(modal.indexOf("const canCreate ="), modal.indexOf(";", modal.indexOf("const canCreate =")));
    expect(canCreate).not.toMatch(/lot|afterCutoff|late/i);
  });

  it("al crear, el lote en su tono: informa, suave tras las 17:00, fuerte tras las 21:20", () => {
    const tone = body(modal, "function lotNoticeTone(");
    expect(tone).toContain('return notice.afterCutoff ? "crit" : notice.late ? "warn" : "info";');
    expect(modal).toContain("<Banner tone={lotNoticeTone(createdLot)} role=\"status\">");
    expect(modal).toContain("{createdLot.after}");
  });

  it("el subtítulo dice quién arma la caja (D1); provincia conserva el de siempre", () => {
    expect(modal).toContain(
      '"Lima y Callao: la caja la arma nuestro almacén y Swayp la recoge en la oficina. Sin guía Aliclik previa."',
    );
    expect(modal).toContain('const SUBTITULO_PROVINCIA = "Despacho desde el stock regional de Swayp (antes Fénix), sin guía Aliclik previa.";');
    expect(modal).toContain("{!preview ? SUBTITULO_SIN_PEDIDO : limaLot ? SUBTITULO_LIMA : SUBTITULO_PROVINCIA}");
  });
});

describe("el servidor manda la operación en la vista previa (app/dashboard/envios/actions.ts)", () => {
  const actions = read("app/dashboard/envios/actions.ts");

  it("con la misma lectura que decide la salida adicional", () => {
    expect(actions).toContain('operation: "lima" | "provincia_cod" | "agencia" | "desconocida";');
    const preview = actions.slice(actions.indexOf("export async function previewDirectFenixGuide("), actions.indexOf("export async function createDirectFenixGuide("));
    expect(preview).toContain("const operation = await operacionDelPedido(admin, order.id);");
    expect(preview).toContain("    operation,\n    outputs: guides,");
    expect(preview).toContain("    city,\n    operation,\n");
    // Una sola lectura de la operación en la vista previa.
    expect(preview.match(/operacionDelPedido\(/g)).toHaveLength(1);
  });

  it("y esa lectura es `order_master.macro_operation`, la fuente del lote del almacén", () => {
    const directa = read("lib/swayp-directa.ts");
    const fn = directa.slice(directa.indexOf("export async function operacionDelPedido("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('.select("macro_operation")');
    expect(read("lib/warehouse-swayp-access.ts")).toMatch(/SWAYP_ORDER_COLUMNS =\s*"[^"]*macro_operation/);
    expect(read("lib/warehouse-swayp.ts")).toContain('if (operation !== "lima") {');
  });
});
