# Plotline agent tools

Plotline previously exposed its persisted DAGs through the UI RPCs but did not register tools in the existing T3 MCP toolkit, so an agent could describe a DAG without creating one. The toolkit now resolves the project and execution link from the authenticated caller and uses the same Plotline service as the UI. Incremental mutations serialize against the persisted DAG; stale whole-DAG saves are rejected to avoid losing concurrent agent changes.

Run-to-task evidence is associated only when both the stored thread and run IDs match. A completed run does not by itself mark a task done; the agent or user must make that decision using the task transition tool or the UI.
