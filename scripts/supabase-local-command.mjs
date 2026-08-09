import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  assertSupabaseLoopbackBindings,
  assertSupabaseProjectStopped,
  ensureSupabaseLoopbackNetwork,
  supabaseLocalNetworkName,
  supabaseLocalProjectId,
  supabaseProjectContainersAreRunning,
} from "./supabase-local-network.mjs";

const command = process.argv[2];
const schemaSnapshotPath = "supabase/schema.generated.sql";

function supabase(argumentsList, capture = false, includeNetwork = true) {
  const networkArguments = includeNetwork ? ["--network-id", supabaseLocalNetworkName] : [];
  return execFileSync("supabase", [...argumentsList, ...networkArguments], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function stopScopedSupabaseStack() {
  supabase(["stop", "--project-id", supabaseLocalProjectId], true, false);
  assertSupabaseProjectStopped();
}

if (command === "stop") {
  stopScopedSupabaseStack();
  process.stdout.write("Stack Supabase local encerrada.\n");
} else {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  if (supabaseProjectContainersAreRunning()) {
    try {
      assertSupabaseLoopbackBindings();
    } catch {
      stopScopedSupabaseStack();
    }
  }
  ensureSupabaseLoopbackNetwork();

  if (command === "start") {
    try {
      supabase(["start"], true);
      assertSupabaseLoopbackBindings();
    } catch (error) {
      if (supabaseProjectContainersAreRunning()) {
        stopScopedSupabaseStack();
      }
      throw error;
    }
    process.stdout.write("Stack Supabase local restrita a 127.0.0.1.\n");
  } else if (command === "status") {
    supabase(["status", "--output", "env"], true);
    assertSupabaseLoopbackBindings();
    process.stdout.write("Stack Supabase local ativa e restrita a 127.0.0.1.\n");
  } else if (command === "test-db") {
    assertSupabaseLoopbackBindings();
    supabase(["test", "db", "--local"]);
  } else if (command === "schema") {
    assertSupabaseLoopbackBindings();
    supabase(
      ["db", "dump", "--local", "--schema", "public,private,audit", "--file", schemaSnapshotPath],
      false,
      false,
    );
    const schemaSnapshot = readFileSync(schemaSnapshotPath, "utf8");
    writeFileSync(schemaSnapshotPath, `${schemaSnapshot.trimEnd()}\n`);
  } else if (command === "types") {
    assertSupabaseLoopbackBindings();
    supabase(["gen", "types", "typescript", "--local", "--schema", "public"]);
  } else {
    throw new Error("Comando Supabase local não suportado.");
  }
}
