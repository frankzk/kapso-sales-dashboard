// Owner, 25-11-2026 (plan de carga, `docs/plan/rendimiento-carga.md`). El cierre de Aliclik anota en cada guía que
// persigue que ya le preguntó, y la base contaba esa anotación como un cambio de la guía: el pedido quedaba
// desfasado, el Master lo recalculaba y cada pestaña del Master se recargaba. Medido: de 1.219 guías de Aliclik
// tocadas en tres horas, 997 solo habían recibido el sello. La 0356 lleva esos dos sellos a la lista de la 0204.
// El comportamiento se prueba en la base (`scripts/sql/aliclik_followup_no_touch_smoke.sql`, en verify-db.sh);
// aquí se vigila que la migración, el cron y los documentos digan lo mismo.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const sql = read("db/migrations/0356_aliclik_followup_no_touch.sql");

/** La lista de columnas que el trigger ignora, tal como aparece en una migración. */
function ignored(source: string): string[][] {
  return [...source.matchAll(/to_jsonb\((?:new|old)\) - array\[([^\]]+)\]/g)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((c) => c[1]!));
}

describe("la 0356: los sellos del cierre de Aliclik no mueven `updated_at`", () => {
  it("amplía la lista de la 0321 con los dos sellos, igual para la fila nueva y la vieja", () => {
    const lists = ignored(sql);
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual(lists[1]);
    expect(lists[0]).toEqual([
      "updated_at", "api_report_at", "api_updated_at",
      "shalom_checked_at", "shalom_not_found_since", "shalom_not_found_count",
      "aliclik_followup_at", "reason_probed_at",
    ]);
    // No pierde nada de la migración anterior que definió la función.
    const before = ignored(read("db/migrations/0321_shalom_checked_at.sql"))[0]!;
    for (const column of before) expect(lists[0]).toContain(column);
    // `last_report_at` sigue contando: los barridos de Olva y Shalom rotan por `updated_at` (0204).
    expect(lists[0]).not.toContain("last_report_at");
  });

  it("solo cambia la función: sin columnas, índices ni datos", () => {
    const body = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(body).toContain("create or replace function public.shipments_touch_updated_at()");
    expect(body).not.toMatch(/\b(alter table|create index|drop |insert into|delete from|update public)\b/i);
  });

  it("los dos sellos son los que escribe el cierre, y nadie más los lee", () => {
    const cron = read("app/api/cron/aliclik-close/route.ts");
    expect(cron).toContain(".update({ aliclik_followup_at: new Date().toISOString() })");
    expect(cron).toContain(".update({ reason_probed_at: new Date().toISOString() })");
    // Nadie más los lee (ni el Master): dejar de recalcular por ellos no esconde nada.
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /aliclik_followup_at|reason_probed_at/.test(read(path))) users.push(path);
      }
    };
    for (const dir of ["app", "lib", "components"]) walk(dir);
    expect(users.sort()).toEqual(["app/api/cron/aliclik-close/route.ts", "lib/aliclik-followup.ts"]);
  });

  it("la prueba de la base corre con las demás", () => {
    const verify = read("scripts/verify-db.sh");
    expect(verify).toContain("scripts/sql/aliclik_followup_no_touch_smoke.sql");
    const smoke = read("scripts/sql/aliclik_followup_no_touch_smoke.sql");
    for (const fail of ["FAIL 1: aliclik_followup_at moved updated_at", "FAIL 2: reason_probed_at moved updated_at", "FAIL 3: the 0321 stamps started moving updated_at", "FAIL 4: last_report_at stopped moving updated_at", "FAIL 5: a real change did not move updated_at"]) {
      expect(smoke).toContain(fail);
    }
    expect(smoke.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("el MOM y DEPLOY lo cuentan, y la migración no se aplica sola", () => {
    const mom = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(mom).toContain("- **Los sellos del cierre de Aliclik tampoco son un cambio (0356, owner 25-11-2026).**");
    expect(mom).toContain("de 1.219 guías de Aliclik tocadas en tres horas, 997 solo habían recibido ese sello");
    const deploy = read("DEPLOY.md");
    const start = deploy.indexOf("### 25-11-2026 · Los sellos del cierre de Aliclik no cuentan como cambio de la guía (0356, MOM §19.2)");
    expect(start).toBeGreaterThan(-1);
    const entry = flat(deploy.slice(start, deploy.indexOf("\n### ", start + 10)));
    expect(entry).toContain('psql "$DATABASE_URL" -f db/migrations/0356_aliclik_followup_no_touch.sql');
    expect(entry).toContain("Se puede desplegar el código **antes o después** de aplicarla");
    expect(entry).toContain("**No se aplica sola**");
  });
});
