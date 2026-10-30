export function correctionPrompt(input: {
  task: {
    title: string;
    description: string;
    acceptanceCriteria?: ReadonlyArray<{ id: string; description: string }> | undefined;
    correctionAttempts?: ReadonlyArray<unknown> | undefined;
  };
  workspace?: string | null;
  summary: string;
  criterionResults: ReadonlyArray<{ criterionId: string; verdict: string; evidence: string }>;
}): string {
  const criteria = input.task.acceptanceCriteria ?? [];
  const results = input.criterionResults
    .map((result) => `- ${result.criterionId} (${result.verdict}): ${result.evidence}`)
    .join("\n");
  return [
    `Correct the application files for this task: ${input.task.title}\n${input.task.description}`,
    `Working directory: ${input.workspace ?? "Use the correction child thread working directory"}.`,
    `This is correction cycle ${(input.task.correctionAttempts?.length ?? 0) + 1} of 3. Preserve the task's intent and make the narrowest appropriate correction.`,
    `Acceptance criteria:\n${criteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`).join("\n") || "None supplied."}`,
    `Verifier summary: ${input.summary}`,
    `Verifier evidence:\n${results || "No criterion-specific evidence was supplied."}`,
    "Modify the application files required to resolve the failed criteria and run the relevant project tests when available. Report modified files, test results, and unresolved issues.",
    "Do not use Plotline MCP tools or create, discover, or update the parent DAG. The backend manages the task lifecycle and schedules independent verification. Worker completion does not establish acceptance.",
  ].join("\n\n");
}
