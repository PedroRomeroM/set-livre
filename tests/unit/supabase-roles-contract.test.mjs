import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../..");
const rolesSql = readFileSync(resolve(repository, "supabase/roles.sql"), "utf8");

describe("Supabase roles bootstrap contract", () => {
  it("creates only the group role and fails closed on privileged attribute drift", () => {
    expect(rolesSql.match(/create role app_dal/giu)).toHaveLength(1);
    expect(rolesSql).not.toMatch(/create role (?!app_dal\b)/iu);
    expect(rolesSql).toContain("and (role.rolsuper or role.rolreplication or role.rolbypassrls)");
    expect(rolesSql).toContain("app_dal possui atributo que somente um superuser pode remover.");
  });

  it("normalizes only attributes available to the managed CREATEROLE identity", () => {
    const alterRole = rolesSql.slice(
      rolesSql.indexOf("alter role app_dal"),
      rolesSql.indexOf("alter role app_dal reset all"),
    );

    expect(alterRole).toContain("nologin");
    expect(alterRole).toContain("noinherit");
    expect(alterRole).toContain("nocreatedb");
    expect(alterRole).toContain("nocreaterole");
    expect(alterRole).toContain("connection limit -1");
    expect(alterRole).not.toMatch(/\b(?:nosuperuser|noreplication|nobypassrls)\b/iu);
    expect(rolesSql).not.toMatch(/\b(?:password|valid until)\b/iu);
    expect(rolesSql).toContain("alter role app_dal reset all;");
  });
});
