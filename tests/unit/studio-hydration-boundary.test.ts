import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("studio hydration boundary", () => {
  it("mounts the complete interactive editor only after the client commit", () => {
    const panelSource = readFileSync(
      resolve(process.cwd(), "src/domains/studios/components/studio-core-panel.tsx"),
      "utf8",
    );
    const hydrationSource = readFileSync(
      resolve(process.cwd(), "src/lib/client/use-hydrated.ts"),
      "utf8",
    );

    const boundaryStart = panelSource.indexOf("export function StudioCorePanel(");
    const hydratedCheck = panelSource.indexOf("if (!hydrated)", boundaryStart);
    const interactiveBranch = panelSource.indexOf('return props.mode === "create"', hydratedCheck);

    expect(boundaryStart).toBeGreaterThan(-1);
    expect(hydratedCheck).toBeGreaterThan(boundaryStart);
    expect(interactiveBranch).toBeGreaterThan(hydratedCheck);
    expect(panelSource).toContain('title="Preparando o editor seguro"');
    expect(panelSource).not.toContain("!hydrated ||");
    expect(hydrationSource).toContain("useState(false)");
    expect(hydrationSource).toContain("useEffect(() =>");
    expect(hydrationSource).toContain("queueMicrotask(() =>");
    expect(hydrationSource).toContain("if (active) setHydrated(true);");
    expect(hydrationSource).toContain("active = false;");
    expect(hydrationSource).not.toContain("useSyncExternalStore(");
  });
});
