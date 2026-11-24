// «Kapta tiene mejoras nuevas» (owner, 24-11-2026: «un aviso muy amigable»).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNewerBuild, publishedBuild } from "@/lib/app-version";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("aviso de versión nueva", () => {
  it("avisa solo si la versión publicada es otra que la de la pestaña", () => {
    expect(isNewerBuild("aaa111", "bbb222")).toBe(true);
    expect(isNewerBuild("aaa111", "aaa111")).toBe(false);
    expect(isNewerBuild("", "bbb222")).toBe(false);
    expect(isNewerBuild("aaa111", "")).toBe(false);
    expect(isNewerBuild(null, undefined)).toBe(false);
    expect(publishedBuild({ VERCEL_GIT_COMMIT_SHA: " abc " })).toBe("abc");
    expect(publishedBuild({})).toBe("");
  });

  it("la pestaña sabe con qué versión se compiló, y la ruta no se guarda en caché", () => {
    expect(read("next.config.ts")).toContain("NEXT_PUBLIC_KAPTA_BUILD: process.env.VERCEL_GIT_COMMIT_SHA");
    expect(read("app/api/version/route.ts")).toContain('"Cache-Control": "no-store, max-age=0"');
  });

  it("amigable: invita, no recarga sola; «Ahora no» la esconde; está en el panel y en Reparto", () => {
    const ui = read("components/new-version-notice.tsx");
    expect(ui).toContain("Kapta tiene mejoras nuevas");
    expect(ui).toContain("Cuando termines lo que estás haciendo, recarga la página para usarlas.");
    expect(ui).toContain("Ahora no");
    expect(ui).toContain('role="status"');
    expect(ui.match(/window\.location\.reload\(\)/g)?.length).toBe(1);
    expect(read("app/dashboard/layout.tsx")).toContain("<NewVersionNotice />");
    expect(read("app/reparto/page.tsx")).toContain("<NewVersionNotice />");
  });
});
