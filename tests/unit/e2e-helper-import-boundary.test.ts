import { describe, expect, it, vi } from "vitest";

describe("E2E helper import boundary", () => {
  it("does not read destructive environment configuration while importing pure helpers", async () => {
    vi.resetModules();
    const readEnvironment = vi.fn(() => {
      throw new Error("environment-read-during-import");
    });
    vi.doMock("../helpers/e2e-environment-file", () => ({
      localE2EEnvironmentValue: vi.fn(),
      readOptionalE2EEnvironmentFile: readEnvironment,
    }));

    try {
      const preflight = await import("../helpers/e2e-database-preflight");
      expect(preflight.withE2EAdminClient).toBeTypeOf("function");
      expect(readEnvironment).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../helpers/e2e-environment-file");
      vi.resetModules();
    }
  });
});
