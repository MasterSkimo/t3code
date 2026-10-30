import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Typed RPCs use T3's existing authenticated environment connection. */
export const plotlineEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "plotline:dag-list",
    tag: WS_METHODS.plotlineList,
    staleTimeMs: 0,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "plotline:dag-save",
    tag: WS_METHODS.plotlineSave,
    concurrency: {
      // Keep the newest completion state if updates arrive during an in-flight save.
      mode: "latest",
      key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId, input.runId]),
    },
  }),
};
