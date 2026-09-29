import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMasterQuery } from "@/lib/master-query";
import { emptyFilters } from "@/lib/order-master-filters";

// Exercise the actual pure pager functions without importing the board's
// drawers, server actions, and courier integrations into a Node render test.
const source = readFileSync(new URL("../components/orders-master.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("orders-master.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && ["PagerControls", "Pager", "LiveListNotice"].includes(statement.name?.text ?? ""));
const compiled = ts.transpileModule(functions.map(statement => statement.getText(parsed)).join("\n")
  + "\nexport { PagerControls, Pager, LiveListNotice };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const moduleExports: Record<string, any> = {};
new Function("require", "exports", compiled)(createRequire(import.meta.url), moduleExports);
type ControlsProps = { page: number; hasNext: boolean; busy: boolean; onPage: (page: number) => void };
const PagerControls = moduleExports.PagerControls as (props: ControlsProps) => ReactElement<{ children: ReactElement<Record<string, any>>[] }> | null;
const Pager = moduleExports.Pager as ComponentType<ControlsProps & { total: number; shown: number }>;
const LiveListNotice = moduleExports.LiveListNotice as (props: {
  visible: boolean; busy: boolean; onStart: () => void;
}) => ReactElement<{ children: ReactElement<Record<string, any>>[] }> | null;

const board = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "OrdersMasterBoard")!;
let navigateSource = "";
function findNavigate(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "navigate") {
    navigateSource = node.initializer!.getText(parsed);
  }
  ts.forEachChild(node, findNavigate);
}
findNavigate(board);
const navigateCode = ts.transpileModule(`return (${navigateSource});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const pollingEffects = board.body!.statements.filter(statement =>
  ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
  && statement.expression.expression.getText(parsed) === "useEffect"
  && /getOrderMasterChangeToken|setListUpdated\(false\)/.test(statement.getText(parsed)));
const pollingCode = ts.transpileModule(pollingEffects.map(statement => statement.getText(parsed)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const renderPolling = new Function("useEffect", "onFirstPage", "listScope", "pageRef", "setListUpdated", "navigatingRef", "changeToken", "router", "getOrderMasterChangeToken", "window", "document", pollingCode);

function pollingHarness() {
  let notice = false;
  let token = "initial";
  let effectIndex = 0;
  const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  const pageRef = { current: 1 };
  const navigatingRef = { current: false };
  const changeToken = { current: null as string | null };
  const getToken = vi.fn(async () => token);
  const router = { refresh: vi.fn(), replace: vi.fn() };
  const browser = { setInterval: vi.fn(setInterval), clearInterval: vi.fn(clearInterval) };
  const document = { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() };
  // Run actual useEffect callbacks with dependency/cleanup semantics, allowing
  // the polling closure to survive page changes as it does in the mounted board.
  function useEffect(run: () => void | (() => void), dependencies: unknown[]) {
    const index = effectIndex++;
    const previous = effects[index];
    if (previous && dependencies.every((dependency, i) => Object.is(dependency, previous.dependencies[i]))) return;
    previous?.cleanup?.();
    effects[index] = { dependencies, cleanup: run() || undefined };
  }
  return {
    render(page: number, scope = "todos") {
      pageRef.current = page;
      effectIndex = 0;
      renderPolling(useEffect, page <= 1, scope, pageRef, (next: boolean) => { notice = next; }, navigatingRef, changeToken, router, getToken, browser, document);
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
    updateToken(next: string) { token = next; },
    get notice() { return notice; },
    router, browser, getToken,
  };
}

afterEach(() => vi.useRealTimers());

describe("Master pager continuation", () => {
  it("keeps Siguiente enabled when the cursor has more rows even after the total shrinks", () => {
    const onPage = vi.fn();
    const element = PagerControls({ page: 2, hasNext: true, busy: false, onPage });
    const next = element!.props.children.find(child => child.props.children === "Siguiente")!;
    expect(next.props.disabled).toBe(false);
    next.props.onClick();
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it("keeps backward navigation visible after reaching a deep page with no next rows", () => {
    const element = PagerControls({ page: 500, hasNext: false, busy: false, onPage: vi.fn() });
    const buttons = element!.props.children.filter(child => child.type === "button");
    expect(buttons[0]!.props.disabled).toBe(false);
    expect(buttons[1]!.props.disabled).toBe(true);
    expect(PagerControls({ page: 1, hasNext: false, busy: false, onPage: vi.fn() })).toBeNull();
  });

  it("disables both directions while navigation is pending", () => {
    const element = PagerControls({ page: 2, hasNext: true, busy: true, onPage: vi.fn() });
    expect(element!.props.children.filter(child => child.type === "button").every(child => child.props.disabled)).toBe(true);
  });

  it("shows the actual visible count without claiming an absolute offset from a changing total", () => {
    const html = renderToStaticMarkup(createElement(Pager, {
      page: 3, hasNext: false, total: 110, shown: 5, busy: false, onPage: vi.fn(),
    }));
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("5 mostrados · 110 pedidos en total");
    expect(text).toContain("Página 3");
    expect(text).not.toContain("201");
    expect(text).not.toContain("3 / 2");
  });

  it("returns directly to the beginning when a deep cursor page became empty", () => {
    const router = { replace: vi.fn() };
    const navigate = new Function("filters", "sortKey", "page", "rows", "view", "substage", "startNav", "router", "pathname", "buildMasterQuery", navigateCode)(
      emptyFilters(), "created", 500, [], "preparacion", "por_armar",
      (run: () => void) => run(), router, "/dashboard/pedidos", buildMasterQuery,
    ) as (next: { page: number }) => void;
    navigate({ page: 499 });
    const url = new URL(router.replace.mock.calls[0]![0], "https://dashboard.test");
    expect(url.searchParams.get("pg")).toBeNull();
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(url.searchParams.get("view")).toBe("preparacion");
    expect(url.searchParams.get("substage")).toBe("por_armar");
  });

  it("announces detected changes on later pages without restarting polling or moving the user", async () => {
    vi.useFakeTimers();
    const harness = pollingHarness();
    harness.render(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.notice).toBe(false);
    harness.render(3);
    harness.updateToken("updated");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.notice).toBe(true);
    expect(harness.router.refresh).toHaveBeenCalledTimes(1);
    expect(harness.router.replace).not.toHaveBeenCalled();

    harness.render(4);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.notice).toBe(true);
    expect(harness.router.refresh).toHaveBeenCalledTimes(1);
    harness.render(4, "preparacion?region=Lima");
    expect(harness.notice).toBe(false);
    expect(harness.getToken).toHaveBeenCalledTimes(3);
    expect(harness.browser.setInterval).toHaveBeenCalledTimes(1);

    harness.updateToken("updated-again");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.notice).toBe(true);
    harness.render(1, "preparacion?region=Lima");
    expect(harness.notice).toBe(false);
    harness.updateToken("first-page-change");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.notice).toBe(false);
    expect(harness.router.refresh).toHaveBeenCalledTimes(3);
    expect(harness.browser.setInterval).toHaveBeenCalledTimes(1);
    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("offers an explicit return action and disables it during navigation", () => {
    const onStart = vi.fn();
    expect(LiveListNotice({ visible: false, busy: false, onStart })).toBeNull();
    const notice = LiveListNotice({ visible: true, busy: false, onStart })!;
    const button = notice.props.children.find(child => child.type === "button")!;
    expect(button.props.children).toBe("Volver al inicio");
    expect(button.props.disabled).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    button.props.onClick();
    expect(onStart).toHaveBeenCalledTimes(1);
    const busy = LiveListNotice({ visible: true, busy: true, onStart })!;
    expect(busy.props.children.find(child => child.type === "button")!.props.disabled).toBe(true);
  });

  it("returns explicitly to the first page preserving current filters and scroll behavior", () => {
    const router = { replace: vi.fn() };
    const filters = { ...emptyFilters(), regions: new Set(["Lima"]) };
    const navigate = new Function("filters", "sortKey", "page", "rows", "view", "substage", "startNav", "router", "pathname", "buildMasterQuery", navigateCode)(
      filters, "created", 3, [{ id: "visible-order" }], "preparacion", "por_armar",
      (run: () => void) => run(), router, "/dashboard/pedidos", buildMasterQuery,
    ) as (next: { page: number }) => void;
    navigate({ page: 1 });
    const call = router.replace.mock.calls[0]!;
    const url = new URL(call[0], "https://dashboard.test");
    expect(url.searchParams.get("pg")).toBeNull();
    expect(url.searchParams.get("cursor")).toBeNull();
    expect(url.searchParams.get("r")).toBe("Lima");
    expect(url.searchParams.get("view")).toBe("preparacion");
    expect(url.searchParams.get("substage")).toBe("por_armar");
    expect(call[1]).toEqual({ scroll: false });
  });
});
