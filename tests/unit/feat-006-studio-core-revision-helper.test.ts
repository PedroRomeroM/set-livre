import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("FEAT-006 Playwright helper", () => {
  it("captures the command body before a successful response can navigate away", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-006-studio-core-revision.ts"),
      "utf8",
    );
    const commandStart = helper.indexOf("async function executeStudioEditorCommand");
    const command = helper.slice(
      commandStart,
      helper.indexOf("export function createFeat006Studio", commandStart),
    );

    expect(command.match(/response\.json\(\)/gu)).toHaveLength(1);
    expect(command.match(/\.click\(\)/gu)).toHaveLength(1);
    expect(command.match(/waitForResponse/gu)).toHaveLength(1);
    expect(command.match(/await executeTrigger\(\)/gu)).toHaveLength(1);
    expect(command).toContain("trigger?: StudioCommandTrigger");
    expect(command).toContain("trigger ??");
    expect(command.indexOf("responsePayload = await response.json()")).toBeLessThan(
      command.indexOf("return true"),
    );
    expect(command.indexOf("responsePayload = await response.json()")).toBeLessThan(
      command.indexOf("await responsePromise"),
    );
    expect(command).toContain(
      "apiSuccessSchema(ownerStudioEditorResultSchema).parse(responsePayload).data",
    );
    expect(command).toContain("expect(response.status()).toBe(200)");
  });

  it("captures and strictly validates discard before a response can navigate away", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-006-studio-core-revision.ts"),
      "utf8",
    );
    const discardStart = helper.indexOf("export async function discardFeat006StudioDraft");
    const discard = helper.slice(
      discardStart,
      helper.indexOf("async function withFeat006AdminPool", discardStart),
    );

    expect(discard.match(/response\.json\(\)/gu)).toHaveLength(1);
    expect(discard.match(/\.click\(\)/gu)).toHaveLength(1);
    expect(discard.match(/waitForResponse/gu)).toHaveLength(1);
    expect(discard.indexOf("responsePayload = await response.json()")).toBeLessThan(
      discard.indexOf("return true"),
    );
    expect(discard.indexOf("responsePayload = await response.json()")).toBeLessThan(
      discard.indexOf("await responsePromise"),
    );
    expect(discard).toContain('data?.action !== "studio.draft.discard"');
    expect(discard).toContain(
      "apiSuccessSchema(studioDraftDiscardResultSchema).parse(responsePayload).data",
    );
    expect(discard).toContain("assertFeat006SafeDiscard");
    expect(discard).toContain("expect(response.status()).toBe(200)");
  });

  it("publishes a revision before validating pointers and restoring the lifecycle trigger", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-006-studio-core-revision.ts"),
      "utf8",
    );
    const publisher = helper.slice(
      helper.indexOf("export async function publishFeat006StudioFixture"),
      helper.indexOf("export async function readFeat006StudioDatabaseState"),
    );
    const statements = [
      "disable trigger studio_revisions_enforce_lifecycle",
      "update public.studio_revisions as revision",
      "update public.studios",
      "set constraints all immediate",
      "enable trigger studio_revisions_enforce_lifecycle",
      "set constraints all deferred",
      'pool.query("commit")',
    ];

    expect(publisher).toContain('pool.query("rollback")');
    expect(publisher.match(/rows\.length !== 1/gu)).toHaveLength(2);
    expect(publisher.match(/disable trigger studio_revisions_enforce_lifecycle/gu)).toHaveLength(1);
    expect(publisher.match(/enable trigger studio_revisions_enforce_lifecycle/gu)).toHaveLength(1);
    for (const [index, statement] of statements.entries()) {
      expect(publisher).toContain(statement);
      if (index > 0) {
        expect(publisher.indexOf(statements[index - 1] ?? "")).toBeLessThan(
          publisher.indexOf(statement),
        );
      }
    }
  });

  it("drains deferred revision events before restoring the lifecycle trigger", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-006-studio-core-revision.ts"),
      "utf8",
    );
    const cleanup = helper.slice(
      helper.indexOf("async function removeFeat006OwnedRows"),
      helper.indexOf("async function verifyFeat006Cleanup"),
    );
    const statements = [
      "disable trigger studio_revisions_enforce_lifecycle",
      "delete from public.studios where owner_user_id = $1::uuid",
      "set constraints all immediate",
      "enable trigger studio_revisions_enforce_lifecycle",
      "set constraints all deferred",
      'pool.query("commit")',
    ];

    expect(cleanup).toContain('parsed.data.email.startsWith("qa_f006_")');
    expect(cleanup).toContain('pool.query("rollback")');
    for (const [index, statement] of statements.entries()) {
      expect(cleanup).toContain(statement);
      if (index > 0) {
        expect(cleanup.indexOf(statements[index - 1] ?? "")).toBeLessThan(
          cleanup.indexOf(statement),
        );
      }
    }
  });

  it("reads the exact draft payload and proves aggregate uniqueness without wildcard selects", () => {
    const helper = readFileSync(
      resolve(process.cwd(), "tests/helpers/feat-006-studio-core-revision.ts"),
      "utf8",
    );
    const reader = helper.slice(
      helper.indexOf("export async function readFeat006StudioDatabaseState"),
      helper.indexOf("async function removeFeat006OwnedRows"),
    );

    expect(reader).not.toContain("select *");
    expect(reader).toContain("draft.name as draft_name");
    expect(reader).toContain("draft.address_complement as draft_complement");
    expect(reader).toContain("draft.studio_type_id as draft_studio_type_id");
    expect(reader).toContain("active_draft.status = 'draft'");
    expect(reader).toContain("owned_studio.owner_user_id = studio.owner_user_id");
    expect(reader.match(/select pg_catalog\.count\(\*\)/gu)).toHaveLength(2);
  });
});
