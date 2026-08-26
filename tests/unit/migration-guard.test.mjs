import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertImmutableMigrations } from "../../scripts/migration-guard.mjs";

const roots = [];
const baseline = "20260824000100_initial_production_baseline.sql";

function git(root, ...arguments_) {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function repository(initialMigration) {
  const root = mkdtempSync(resolve(tmpdir(), "set-livre-migrations-"));
  roots.push(root);
  mkdirSync(resolve(root, "supabase/migrations"), { recursive: true });
  git(root, "init");
  git(root, "config", "user.email", "tests@setlivre.invalid");
  git(root, "config", "user.name", "Set Livre tests");
  writeFileSync(resolve(root, "supabase/migrations", initialMigration), "select 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { baseRef: git(root, "rev-parse", "HEAD"), root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("migration immutability", () => {
  it("allows the one-time empty-production consolidation", () => {
    const fixture = repository("20260809000100_old.sql");
    rmSync(resolve(fixture.root, "supabase/migrations/20260809000100_old.sql"));
    writeFileSync(resolve(fixture.root, "supabase/migrations", baseline), "select 2;\n");

    expect(
      assertImmutableMigrations({
        ...fixture,
        bootstrapBaseCommit: fixture.baseRef,
      }),
    ).toMatchObject({
      bootstrap: true,
      added: [baseline],
    });
  });

  it("rejects the one-time consolidation when main moved beyond the audited empty-production base", () => {
    const fixture = repository("20260809000100_old.sql");
    rmSync(resolve(fixture.root, "supabase/migrations/20260809000100_old.sql"));
    writeFileSync(resolve(fixture.root, "supabase/migrations", baseline), "select 2;\n");

    expect(() => assertImmutableMigrations(fixture)).toThrow("produção vazia");
  });

  it("rejects editing or deleting a migration already present in main", () => {
    const fixture = repository(baseline);
    writeFileSync(resolve(fixture.root, "supabase/migrations", baseline), "select 2;\n");
    expect(() => assertImmutableMigrations(fixture)).toThrow("alterada");

    rmSync(resolve(fixture.root, "supabase/migrations", baseline));
    expect(() => assertImmutableMigrations(fixture)).toThrow("excluída");
  });

  it("allows only a later append-only migration", () => {
    const fixture = repository(baseline);
    const added = "20260825000100_next_slice.sql";
    writeFileSync(resolve(fixture.root, "supabase/migrations", added), "select 2;\n");

    expect(assertImmutableMigrations(fixture)).toMatchObject({ bootstrap: false, added: [added] });
  });
});
