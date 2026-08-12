import "server-only";

export function assertOwnerContractRuntime(source: "approved" | "local_fixture") {
  const appEnvironment = process.env.APP_ENV;
  if (source === "local_fixture" && appEnvironment !== "local" && appEnvironment !== "test") {
    throw new Error("O contrato local do dono é proibido fora de local/test.");
  }
}
