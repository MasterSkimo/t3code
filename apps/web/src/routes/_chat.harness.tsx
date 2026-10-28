import { createFileRoute } from "@tanstack/react-router";
import { HarnessHubPage } from "../components/HarnessHubPage";

export const Route = createFileRoute("/_chat/harness")({ component: HarnessHubPage });
