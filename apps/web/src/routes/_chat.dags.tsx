import { createFileRoute } from "@tanstack/react-router";
import { PlotlineDagsPage } from "../components/PlotlineDagsPage";

export const Route = createFileRoute("/_chat/dags")({ component: PlotlineDagsPage });
