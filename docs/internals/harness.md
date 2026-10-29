# Harness learning boundaries

The collector derives bounded, provider-neutral signals from committed orchestration and Plotline events. The analysis service uses the existing text-generation adapter and stores evidence-backed proposals; approval permits export, not a provider configuration write.

Existing installations can contain receipts and interrupted filesystem operations from older Harness versions. The proposal service retains recovery and rollback for those records, including integrity checks that protect subsequent user edits. This legacy path must not install new changes.

See the [proposal service](../../apps/server/src/harness/HarnessProposalService.ts) and [analysis service](../../apps/server/src/harness/HarnessAnalysisService.ts).
