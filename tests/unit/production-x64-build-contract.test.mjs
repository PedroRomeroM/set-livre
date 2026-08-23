import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(repository, ".github/workflows/prd-deploy.yaml"), "utf8");
const ciWorkflow = readFileSync(resolve(repository, ".github/workflows/ci.yaml"), "utf8");
const generator = readFileSync(resolve(repository, "scripts/release-manifest.mjs"), "utf8");

describe("canonical Linux x64 production artifact contract", () => {
  it("generates and smokes the canonical release on every main or recovery run", () => {
    const start = ciWorkflow.indexOf(
      "      - name: Build pull request or generate the canonical Linux x64 release",
    );
    const end = ciWorkflow.indexOf("      - name: Supply-chain and dead-code gates", start);
    const canonicalBuild = ciWorkflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(canonicalBuild).toContain('if [[ "$GITHUB_EVENT_NAME" == pull_request ]]');
    expect(canonicalBuild).toContain("npm run build");
    expect(canonicalBuild).toContain('node scripts/release-manifest.mjs generate "$RELEASE_SHA"');
    expect(ciWorkflow).toContain("if: github.event_name != 'pull_request'");
    expect(ciWorkflow).toContain("PRD_PUBLIC_APP_URL: ${{ vars.PRD_PUBLIC_APP_URL }}");
    expect(ciWorkflow).toContain("PRD_BACKOFFICE_APP_URL: ${{ vars.PRD_BACKOFFICE_APP_URL }}");
    expect(ciWorkflow).toContain("PRD_SUPABASE_URL: ${{ vars.PRD_SUPABASE_URL }}");
    expect(ciWorkflow).toContain("PRD_SUPABASE_ANON_KEY: ${{ vars.PRD_SUPABASE_ANON_KEY }}");
    expect(generator).toContain("publicBuildConfigSha256: buildConfigSha256");
    expect(generator).toContain("publicBuildConfigurationFromBuildEnvironments(buildEnvironments)");
    expect(generator).toContain("await smokePackagedApplications(commit, localEnvironments)");
    expect(generator).toContain('assertPhysicalTree(releaseRoot, "Release completa após smoke")');
  });

  it("keeps generation out of the production handoff workflow", () => {
    const download = workflow.indexOf(
      "      - name: Download the canonical artifact from the exact CI run",
    );
    const verify = workflow.indexOf(
      "      - name: Verify the canonical archive and schema 4 contract",
    );
    const publish = workflow.indexOf("      - name: Publish immutable release artifact");

    expect(download).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(download);
    expect(publish).toBeGreaterThan(verify);
    expect(workflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(workflow).toContain("node scripts/release-manifest.mjs verify");
    expect(workflow).toContain("PRD_PUBLIC_APP_URL: ${{ vars.PRD_PUBLIC_APP_URL }}");
    expect(workflow).toContain("PRD_BACKOFFICE_APP_URL: ${{ vars.PRD_BACKOFFICE_APP_URL }}");
    expect(workflow).toContain("PRD_SUPABASE_URL: ${{ vars.PRD_SUPABASE_URL }}");
    expect(workflow).toContain("PRD_SUPABASE_ANON_KEY: ${{ vars.PRD_SUPABASE_ANON_KEY }}");
    expect(workflow).not.toContain("npm run build");
    expect(workflow).not.toContain("Package a deterministic");
    expect(workflow).not.toContain("supabase db push");
  });

  it("regenerates only a previously approved merged SHA with immutable workflow IDs", () => {
    expect(ciWorkflow).toContain("workflow_dispatch:");
    expect(ciWorkflow).toContain("approved_run_id:");
    expect(ciWorkflow).toContain("approved_run_attempt:");
    expect(ciWorkflow).toContain(
      'await git("merge-base", "--is-ancestor", releaseSha, "refs/remotes/origin/main")',
    );
    expect(ciWorkflow).toContain("approved.display_title !== `Release ${releaseSha}`");
    expect(ciWorkflow).toContain('job.name !== "Verify and publish canonical Linux x64 release"');
    expect(ciWorkflow).toContain('step?.name === "Publish immutable release artifact"');
    expect(ciWorkflow).toContain("EXPECTED_CI_WORKFLOW_ID: ${{ vars.CI_GITHUB_WORKFLOW_ID }}");
    expect(ciWorkflow).toContain("EXPECTED_PRD_WORKFLOW_ID: ${{ vars.PRD_GITHUB_WORKFLOW_ID }}");
    expect(ciWorkflow).toContain("EXPECTED_REPOSITORY_ID: ${{ vars.SET_LIVRE_REPOSITORY_ID }}");
    expect(ciWorkflow).not.toContain("vars.GITHUB_REPOSITORY_ID");
    expect(workflow).toContain("format('{0}', github.event.workflow_run.workflow_id)");
    expect(workflow).toContain("Recovered release {0}");
  });

  it("contains no ARM64 runtime, deployment secret, SSH path or manual fallback", () => {
    const sources = `${ciWorkflow}\n${workflow}\n${generator}`;
    expect(sources).not.toMatch(/arm64|aarch64|ubuntu-24\.04-arm/iu);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toMatch(/PRD_SSH|known_hosts|\bssh\b|\bscp\b/iu);
    expect(sources).not.toMatch(/continue-on-error|workflow_dispatch.*fallback|manual rerun/iu);
    expect(generator).toContain('platform !== "linux" || arch !== "x64"');
  });
});
