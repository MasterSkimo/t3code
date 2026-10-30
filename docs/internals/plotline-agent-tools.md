# Plotline agent tools

Plotline previously exposed its persisted DAGs through the UI RPCs but did not register tools in the existing T3 MCP toolkit, so an agent could describe a DAG without creating one. The toolkit now resolves the project and execution link from the authenticated caller and uses the same Plotline service as the UI. Incremental mutations serialize against the persisted DAG; stale whole-DAG saves are rejected to avoid losing concurrent agent changes.

Run-to-task evidence is associated only when both the stored thread and run IDs match. A completed run does not by itself mark a task done; the agent or user must make that decision using the task transition tool or the UI.

Verification attempts retain their criteria version and the task's linked run ID. A passing attempt only authorizes completion while both still match; relinking the task to another run makes the earlier result stale without deleting its history. Recording a failed verification durably reserves a T3-owned correction and dispatches it through the existing delegated-task command/outbox path; the correction history keeps the verifier and child task/run identities for replay and re-verification. T3 caps each task at three corrections and stops/escalates when a correction fails, is cancelled, or is interrupted. This is outside the provider's internal agent loop; acceptance still requires a current passing verification.

Automatic reverification carries the stored task and criteria to a server-owned verifier in the correction's workspace, even after the originating run completes. Technical failures are retried with durable diagnostics and do not create acceptance verdicts; escalation is conditional on the same criteria version and run.
