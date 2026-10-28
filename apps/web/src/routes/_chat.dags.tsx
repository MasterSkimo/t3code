import { createFileRoute } from "@tanstack/react-router";
import { PlotlineDagsPage } from "../components/PlotlineDagsPage";

function PlotlineDagsRoute() {
  const { dagId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PlotlineDagsPage
      selectedDagId={dagId}
      onSelectDag={(nextDagId) => {
        void navigate({
          search: (previous) => {
            const nextSearch = { ...previous };
            delete nextSearch.dagId;
            return nextDagId ? { ...nextSearch, dagId: nextDagId } : nextSearch;
          },
        });
      }}
    />
  );
}

export function validateDagsSearch(raw: Record<string, unknown>) {
  const dagId = typeof raw.dagId === "string" ? raw.dagId.trim().slice(0, 200) : "";
  return dagId.length > 0 ? { dagId } : {};
}

export const Route = createFileRoute("/_chat/dags")({
  validateSearch: validateDagsSearch,
  component: PlotlineDagsRoute,
});
