import { expect, it } from "@effect/vitest";
import { correctionPrompt } from "./correctionPrompt.ts";

it("provides the correction worker its task, evidence, and independent execution contract", () => {
  const prompt = correctionPrompt({
    task: {
      title: "Fix pricing",
      description: "Correct the total for discounted items.",
      acceptanceCriteria: [
        { id: "total", description: "Discount is applied once" },
        { id: "tax", description: "Tax remains correct" },
      ],
      correctionAttempts: [{}],
    },
    workspace: "/project",
    summary: "The total is wrong",
    criterionResults: [
      {
        criterionId: "total",
        verdict: "fail",
        evidence: "The focused test returned 80 instead of 90.",
      },
    ],
  });
  expect(prompt).toContain("Correct the total for discounted items.");
  expect(prompt).toContain("Discount is applied once");
  expect(prompt).toContain("Tax remains correct");
  expect(prompt).toContain("The focused test returned 80 instead of 90.");
  expect(prompt).toContain("Working directory: /project");
  expect(prompt).toContain("correction cycle 2");
  expect(prompt).toContain("Modify the application files");
  expect(prompt).toContain("run the relevant project tests");
  expect(prompt).toContain("Report modified files, test results, and unresolved issues");
  expect(prompt).toContain(
    "Do not use Plotline MCP tools or create, discover, or update the parent DAG",
  );
  expect(prompt).toContain("Worker completion does not establish acceptance");
});
