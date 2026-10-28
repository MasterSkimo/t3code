# Native Plotline DAGs

Ask an agent in a T3 thread to create or update a DAG, and it can use T3's native Plotline tools to save it in the current project. The DAG is associated with its originating conversation and appears in the conversation's right panel. If that thread has no other panel surfaces open, Plotline opens automatically; otherwise use the Plotline entry in the panel launcher.

Plotline is an execution observer. You can switch between runs, zoom and pan the dependency graph, inspect tasks and activity, pause live updates, and open a linked task conversation. Only the agent/orchestrator tools can change the DAG or task state. Existing `/dags?dagId=…` links open the originating conversation panel when the DAG has one; unlinked legacy DAGs remain available in the read-only list view.

Ask explicitly for Markdown or Mermaid if you want a file or text instead.

Changes through the agent tools are unavailable in Plan mode. If the provider session does not expose T3's MCP tools, the agent cannot create a native DAG through them.
