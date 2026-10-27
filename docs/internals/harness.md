# Harness learning boundaries

Harness separates activity signals, model analysis, proposal decisions, and filesystem changes. The event collector turns committed orchestration and Plotline events into bounded, provider-neutral signals. The analysis service sends those signals and the current skill inventory through the configured text-generation adapter; provider-specific behavior stays behind that adapter. Raw provider protocols do not enter the proposal service.

Analysis produces a stored proposal. It does not write a skill. Approval is a separate decision, and applying an approved proposal is a separate action. Keep that boundary when adding automatic analysis or another client surface: model output is untrusted suggested content, and a setting that permits analysis must not also grant permission to mutate a skill.

Skills use the common `.agents/skills/<name>/SKILL.md` convention. Discovery treats skills without a valid Harness integrity marker as user-owned. Harness writes into a dedicated managed location with staged filesystem changes, and checks the saved content hash before replacing, archiving, or rolling back a managed skill. A user edit after Harness applies a change must be preserved rather than silently overwritten.

Proposal state is stored in SQLite while skill content lives on disk, so those writes cannot share one transaction. The proposal service records an in-progress state and audit entry before changing files, then commits the receipt after the file operation. Startup recovery resolves interrupted apply or rollback attempts. Preserve this recovery path and the receipt checks when changing proposal lifecycle behavior.

See [proposal service](../../apps/server/src/harness/HarnessProposalService.ts), [analysis service](../../apps/server/src/harness/HarnessAnalysisService.ts), and [managed skill writes](../../apps/server/src/harness/skills.ts).
