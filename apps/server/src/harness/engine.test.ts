import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { makeHarnessEngine } from "./engine.ts";

it.effect(
  "uses replaceable structured inference and bounds and validates native-v1 proposals",
  () =>
    Effect.gen(function* () {
      let prompt = "";
      const textGeneration = TextGeneration.TextGeneration.of({
        generateCommitMessage: () => Effect.die(new Error("unused")),
        generatePrContent: () => Effect.die(new Error("unused")),
        generateBranchName: () => Effect.die(new Error("unused")),
        generateThreadTitle: () => Effect.die(new Error("unused")),
        generateReviewGuide: () => Effect.die(new Error("unused")),
        generateStructuredOutput: ((input: { prompt: string }) => {
          prompt = input.prompt;
          return Effect.succeed({
            proposals: [
              {
                operation: "create",
                skillName: "Review Helper",
                targetSkillIds: ["new", "new"],
                evidence: ["Repeated review checklist"],
                sourceRefs: ["event:1", "unrelated"],
                contentDiff: { before: null, after: "---\nname: review-helper\n---\n" },
                confidence: 2,
                rationale: "The same review sequence appears repeatedly.",
              },
            ],
          });
        }) as typeof TextGeneration.TextGeneration.Service.generateStructuredOutput,
      });
      const engine = yield* makeHarnessEngine.pipe(
        Effect.provideService(TextGeneration.TextGeneration, textGeneration),
      );
      const result = yield* engine.analyze({
        cwd: "/repo",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        context: "Private project context",
        events: [
          {
            id: "event:1",
            threadId: "thread:1",
            at: "2026-10-27T00:00:00.000Z",
            type: "repeated_workflow",
            summary: "Repeated review checklist",
            evidence: ["Review steps recur"],
            sourceRefs: ["event:1"],
          },
        ],
        skills: [
          { id: "existing", title: "Review", description: "Review code", content: "Review" },
        ],
      });
      assert.strictEqual(result.engineId, "native-v1");
      assert.strictEqual(result.engineVersion, "1");
      assert.strictEqual(result.proposals[0]?.confidence, 1);
      assert.deepStrictEqual(result.proposals[0]?.targetSkillIds, ["new"]);
      assert.deepStrictEqual(result.proposals[0]?.sourceRefs, ["event:1"]);
      assert.ok(prompt.includes("Private project context"));
      assert.ok(prompt.includes("Review code"));
    }),
);
