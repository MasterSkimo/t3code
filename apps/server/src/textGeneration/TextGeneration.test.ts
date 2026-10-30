import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "@t3tools/contracts";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { runStructuredOutput } from "./TextGeneration.ts";

const unused = () => Effect.die(new Error("unused"));

const textGeneration = (
  supportsStructuredOutput: boolean | undefined,
  generateStructuredOutput: ProviderTextGeneration["generateStructuredOutput"],
): ProviderTextGeneration => ({
  ...(supportsStructuredOutput === undefined ? {} : { supportsStructuredOutput }),
  generateCommitMessage: unused,
  generatePrContent: unused,
  generateBranchName: unused,
  generateThreadTitle: unused,
  generateReviewGuide: unused,
  generateStructuredOutput,
});

it.effect("requires an explicit provider capability before structured inference", () =>
  Effect.gen(function* () {
    let calls = 0;
    const schema = Schema.Struct({ result: Schema.String });
    const input = {
      cwd: "/repo",
      prompt: "Return result",
      outputSchema: schema,
      modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: "model" },
    };
    const unsupported = yield* Effect.flip(
      runStructuredOutput(
        textGeneration(undefined, () => {
          calls += 1;
          return Effect.succeed({ result: "unexpected" });
        }),
        input,
      ),
    );
    assert.strictEqual(unsupported._tag, "TextGenerationError");
    assert.strictEqual(calls, 0);

    const supported = yield* runStructuredOutput(
      textGeneration(true, () => {
        calls += 1;
        return Effect.succeed({ result: "ok" });
      }),
      input,
    );
    assert.deepStrictEqual(supported, { result: "ok" });
    assert.strictEqual(calls, 1);
  }),
);
