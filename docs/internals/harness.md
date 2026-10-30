# Harness learning boundaries

The collector derives bounded, provider-neutral signals from committed orchestration and Plotline events. The analysis service uses the existing text-generation adapter and stores evidence-backed proposals; approval permits export, not a provider configuration write.

Automatic inference is triggered only by a terminal provider run event (`run.updated` completed or failed) whose projected thread is the project root. That event creates a durable root candidate. Child completion/failure and Plotline task transitions only wake candidate reevaluation; they cannot create candidates. Before inference, the candidate's run must still be the root's latest run, the root must have no active run, descendants must be settled, and no associated DAG may be running or waiting. Older candidates are superseded by a later root run. Missing projects/roots supersede their candidates. Project-list read failures retry the wake event and leave candidates pending; failures while evaluating a specific candidate increment that candidate's failure count and do not stop later candidates.

Candidates deferred by the daily analysis budget are retried only when another Harness or Plotline event wakes reevaluation, or after server startup. There is no scheduled next-day wake and no polling, so a budget-deferred candidate can remain pending until another such event or restart occurs.

Existing installations can contain receipts and interrupted filesystem operations from older Harness versions. The proposal service retains recovery and rollback for those records, including integrity checks that protect subsequent user edits. This legacy path must not install new changes.

See the [proposal service](../../apps/server/src/harness/HarnessProposalService.ts) and [analysis service](../../apps/server/src/harness/HarnessAnalysisService.ts).
