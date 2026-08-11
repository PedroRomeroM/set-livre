import { EventEmitter } from "node:events";

import { runLocalProductionPreviewProcessFlow } from "../../scripts/local-production-process-tree.mjs";
import { runLocalProductionServerCli } from "../../scripts/local-production-server.mjs";

const requestedMode = process.argv[2];
const requestedExit = Number(requestedMode);

function closingChild(pid) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = pid;
  child.signalCode = null;
  queueMicrotask(() => {
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}

await runLocalProductionServerCli({
  application: "web",
  argumentCount: 3,
  runServer: async () => {
    if (requestedMode === "premature") {
      return runLocalProductionPreviewProcessFlow({
        platform: "linux",
        prepareBuild: () => {},
        signalProcessGroup: (_pid, signal) => {
          if (signal === 0) {
            const error = new Error("missing process group");
            error.code = "ESRCH";
            throw error;
          }
        },
        signalSource: new EventEmitter(),
        startBuild: (registerProcess) => registerProcess({ child: closingChild(633_001) }),
        startServer: (registerProcess) => registerProcess({ child: closingChild(633_002) }),
        validateBuild: () => {},
      });
    }
    const error = new Error("fixture failure");
    if (Number.isSafeInteger(requestedExit)) {
      error.exitCode = requestedExit;
    }
    throw error;
  },
  writeError: () => {},
});
