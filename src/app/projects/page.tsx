import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectExplorer } from "@/components/exchange/ProjectExplorer";

export const metadata: Metadata = {
  title: "Explore carbon projects",
  description:
    "Explore Carbadia demonstration credits and separately browse sourced real registry project records.",
};
export default function ProjectsPage() {
  return (
    <Suspense
      fallback={<div className="ex-loading">Loading project explorer…</div>}
    >
      <ProjectExplorer />
    </Suspense>
  );
}
