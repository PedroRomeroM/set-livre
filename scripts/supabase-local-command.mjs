import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { assertDatabaseGeneratedArtifactsCurrent } from "./check-database-generated-artifacts.mjs";
import { assertLocalDockerDaemon } from "./docker-local-context.mjs";
import { generateDatabaseTypes } from "./generate-database-types.mjs";
import { generateSchemaSnapshot } from "./generate-schema-snapshot.mjs";
import {
  assertSupabaseLoopbackBindings,
  assertSupabaseProjectStopped,
  ensureSupabaseLoopbackNetwork,
  supabaseLocalProjectId,
  supabaseProjectContainersAreRunning,
} from "./supabase-local-network.mjs";
import { executeSupabaseLocalCommand } from "./supabase-command-executor.mjs";

const command = process.argv[2];
const localDockerEnvironment = assertLocalDockerDaemon();

function supabase(argumentsList, capture = false, includeNetwork = true) {
  return executeSupabaseLocalCommand(argumentsList, {
    capture,
    environment: localDockerEnvironment,
    includeNetwork,
  });
}

function stopScopedSupabaseStack() {
  supabase(["stop", "--project-id", supabaseLocalProjectId], true, false);
  assertSupabaseProjectStopped(localDockerEnvironment);
}

if (command === "stop") {
  stopScopedSupabaseStack();
  process.stdout.write("Stack Supabase local encerrada.\n");
} else {
  execFileSync("docker", ["info"], { env: localDockerEnvironment, stdio: "ignore" });
  if (supabaseProjectContainersAreRunning(localDockerEnvironment)) {
    try {
      assertSupabaseLoopbackBindings(localDockerEnvironment);
    } catch {
      stopScopedSupabaseStack();
    }
  }
  ensureSupabaseLoopbackNetwork(localDockerEnvironment);

  if (command === "start") {
    try {
      supabase(["start"], true);
      assertSupabaseLoopbackBindings(localDockerEnvironment);
    } catch (error) {
      if (supabaseProjectContainersAreRunning(localDockerEnvironment)) {
        stopScopedSupabaseStack();
      }
      throw error;
    }
    process.stdout.write("Stack Supabase local restrita a 127.0.0.1.\n");
  } else if (command === "status") {
    supabase(["status", "--output", "env"], true);
    assertSupabaseLoopbackBindings(localDockerEnvironment);
    process.stdout.write("Stack Supabase local ativa e restrita a 127.0.0.1.\n");
  } else if (command === "test-db") {
    assertSupabaseLoopbackBindings(localDockerEnvironment);
    supabase(["test", "db", "--local"]);
    await assertDatabaseGeneratedArtifactsCurrent({
      generateSchema: (destinationPath) =>
        generateSchemaSnapshot({
          destinationPath,
          runDump: (temporaryPath) =>
            supabase(
              [
                "db",
                "dump",
                "--local",
                "--schema",
                "public,private,audit",
                "--file",
                temporaryPath,
              ],
              true,
              false,
            ),
        }),
      generateTypes: (destinationPath) =>
        generateDatabaseTypes({
          destinationPath,
          runGenerator: (outputDescriptor) => {
            const generatedTypes = supabase(
              ["gen", "types", "typescript", "--local", "--schema", "public"],
              true,
            );
            writeFileSync(outputDescriptor, generatedTypes, "utf8");
          },
        }),
    });
    process.stdout.write("Artefatos gerados do banco conferem com a instância local.\n");
  } else if (command === "schema") {
    assertSupabaseLoopbackBindings(localDockerEnvironment);
    generateSchemaSnapshot({
      runDump: (temporaryPath) =>
        supabase(
          ["db", "dump", "--local", "--schema", "public,private,audit", "--file", temporaryPath],
          true,
          false,
        ),
    });
  } else if (command === "types") {
    assertSupabaseLoopbackBindings(localDockerEnvironment);
    supabase(["gen", "types", "typescript", "--local", "--schema", "public"]);
  } else {
    throw new Error("Comando Supabase local não suportado.");
  }
}
