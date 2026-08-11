import { execFileSync } from "node:child_process";

import { supabaseLocalNetworkName } from "./supabase-local-network.mjs";

const safeSignalPattern = /^SIG[A-Z0-9]+$/u;

function sanitizedSupabaseFailure(error) {
  if (error !== null && typeof error === "object") {
    if (Number.isInteger(error.status)) {
      return new Error(`O comando Supabase local falhou com código ${error.status}.`);
    }
    if (typeof error.signal === "string" && safeSignalPattern.test(error.signal)) {
      return new Error(`O comando Supabase local falhou com sinal ${error.signal}.`);
    }
  }
  return new Error("O comando Supabase local falhou sem diagnóstico público.");
}

function executeInstalledSupabase(argumentsList, options) {
  return execFileSync("supabase", argumentsList, options);
}

export function executeSupabaseLocalCommand(
  argumentsList,
  {
    capture = false,
    environment = process.env,
    executeCommand = executeInstalledSupabase,
    includeNetwork = true,
  } = {},
) {
  const networkArguments = includeNetwork ? ["--network-id", supabaseLocalNetworkName] : [];

  try {
    return executeCommand([...argumentsList, ...networkArguments], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
    });
  } catch (error) {
    throw sanitizedSupabaseFailure(error);
  }
}
