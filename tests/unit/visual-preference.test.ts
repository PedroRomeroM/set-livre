import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  applyVisualPreference,
  visualPreferenceLabel,
  visualPreferenceOptions,
} from "../../src/domains/identity/components/visual-preference";
import {
  profilePreferenceCookieName,
  profilePreferenceFromCookieStore,
} from "../../src/domains/identity/server/profile-preference-cookie";

describe("visual preference", () => {
  it("keeps the native selector allowlist closed", () => {
    expect(visualPreferenceOptions.map((option) => option.value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
    expect(visualPreferenceLabel("system")).toBe("Usar preferência do dispositivo");
    expect(visualPreferenceLabel("dark")).toBe("Tema escuro");
  });

  it("applies only a validated preference to the document dataset", () => {
    const target: { dataset: Record<string, string | undefined> } = { dataset: {} };
    applyVisualPreference(target, "dark");
    expect(target.dataset).toEqual({ colorScheme: "dark" });
    applyVisualPreference(target, "system");
    expect(target.dataset).toEqual({ colorScheme: "system" });
  });

  it("defaults an absent or invalid HttpOnly projection to system", () => {
    expect(profilePreferenceCookieName).toBe("sl-color-scheme");
    expect(profilePreferenceFromCookieStore({ get: () => undefined })).toBe("system");
    expect(profilePreferenceFromCookieStore({ get: () => ({ value: "attacker-theme" }) })).toBe(
      "system",
    );
    expect(profilePreferenceFromCookieStore({ get: () => ({ value: "light" }) })).toBe("light");
  });

  it("has explicit light, dark and system token selectors", () => {
    const tokens = readFileSync(resolve(process.cwd(), "packages/ui/src/tokens.css"), "utf8");
    const layout = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
    const cookie = readFileSync(
      resolve(process.cwd(), "src/domains/identity/server/profile-preference-cookie.ts"),
      "utf8",
    );

    expect(tokens).toContain(':root[data-color-scheme="light"]');
    expect(tokens).toContain(':root[data-color-scheme="dark"]');
    expect(tokens).toContain(':root[data-color-scheme="system"]');
    expect(layout).toContain("data-color-scheme={colorScheme}");
    expect(cookie).toContain("httpOnly: true");
    expect(cookie).toContain('sameSite: "lax"');
  });
});
