import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const migration = readFileSync(
  resolve(
    repositoryRoot,
    "supabase/migrations/20260819000100_supabase_rls_event_trigger_acl_hardening.sql",
  ),
  "utf8",
);
const generatedSchema = readFileSync(
  resolve(repositoryRoot, "supabase/schema.generated.sql"),
  "utf8",
);

function captureSingle(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  expect(matches, label).toHaveLength(1);
  return matches[0][1].replaceAll("\r\n", "\n").trim();
}

describe("Supabase RLS event-trigger ACL hardening migration", () => {
  it("is an incrementally deployable, strictly classified security expansion", () => {
    expect(migration).toMatch(/^-- set-livre:migration-mode=expand-only\r?\n/u);
    expect(migration).toMatch(
      /do \$managed_rls_acl\$\r?\nbegin\r?\n  if pg_catalog\.to_regprocedure\('public\.rls_auto_enable\(\)'\) is not null then\r?\n    revoke all on function public\.rls_auto_enable\(\)\r?\n      from public, anon, authenticated, service_role, app_dal;\r?\n  end if;\r?\nend\r?\n\$managed_rls_acl\$;/u,
    );
    expect(migration.match(/^do\s+\$[A-Za-z_][A-Za-z0-9_]*\$/gimu)).toEqual([
      "do $managed_rls_acl$",
    ]);
  });

  it("defines the exact readiness window over the unchanged main manifest", () => {
    expect(migration).toMatch(
      /create or replace function private\.check_readiness\(expected_version text\)\r?\nreturns boolean\r?\nlanguage sql\r?\nstable\r?\nsecurity definer\r?\nset search_path = ''\r?\nas \$function\$/u,
    );
    expect(migration).toContain("pg_catalog.count(*) = 17");
    expect(migration).toContain("pg_catalog.count(*) = 16");
    expect(migration).toContain("array['20260815000100'::text, '20260819000100'::text]");
    expect(migration).not.toMatch(
      /create_studio|update_studio_revision_core|discard_studio_draft/u,
    );
    expect(migration).toMatch(
      /revoke all on function private\.check_readiness\(text\)\r?\n  from public, anon, authenticated, service_role, app_dal;\r?\ngrant execute on function private\.check_readiness\(text\)\r?\n  to app_dal;/u,
    );
  });

  it("keeps the complete behavior byte-equivalent to the generated schema body", () => {
    const migrationBody = captureSingle(
      migration,
      /as \$function\$\r?\n([\s\S]*?)\r?\n\$function\$;/gu,
      "migration check_readiness body",
    );
    const generatedBody = captureSingle(
      generatedSchema,
      /CREATE OR REPLACE FUNCTION "private"\."check_readiness"\("expected_version" "text"\) RETURNS boolean\r?\n    LANGUAGE "sql" STABLE SECURITY DEFINER\r?\n    SET "search_path" TO ''\r?\n    AS \$\$\r?\n([\s\S]*?)\r?\n\$\$;/gu,
      "generated check_readiness body",
    );

    expect(migrationBody).toBe(generatedBody);
  });

  it("contains no catalog-source surgery or dynamic SQL execution", () => {
    expect(migration).not.toMatch(/pg_catalog\.pg_get_functiondef/iu);
    expect(migration).not.toMatch(/pg_catalog\.replace\s*\(/iu);
    expect(migration).not.toMatch(/^\s*execute\s+/imu);
  });
});
