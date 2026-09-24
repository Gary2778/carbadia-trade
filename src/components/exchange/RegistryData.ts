"use client";

import { useCallback, useState } from "react";
import { api } from "@/lib/http/client";
import { usePolling } from "@/hooks/usePolling";

export const OFFSETS_SOURCE = "https://carbonplan.org/research/offsets-db";
export const REGISTRY_LABELS: Record<string, string> = {
  verra: "Verra",
  "gold-standard": "Gold Standard",
  "american-carbon-registry": "American Carbon Registry",
  "climate-action-reserve": "Climate Action Reserve",
  "art-trees": "ART TREES",
  isometric: "Isometric",
  cercarbono: "Cercarbono",
};
export const registryLabel = (value: string) => REGISTRY_LABELS[value] ?? value;
export const categoryLabel = (value: string) =>
  value.replaceAll("-", " ").replace(/^./, (s) => s.toUpperCase());
export function sourceUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export type RegistryOverview = {
  asOf: string | null;
  totals: { projects: number; issued: number; retired: number };
  registries: {
    registry: string;
    projects: number;
    issued: number;
    retired: number;
  }[];
  years: { year: number; issuance: number; retirement: number }[];
  beneficiaries: { name: string; tonnes: number }[];
  filters: { countries: string[]; categories: string[] };
};
export function useRegistryOverview() {
  const [overview, setOverview] = useState<RegistryOverview | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setOverview(await api<RegistryOverview>("/api/real/overview"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);
  usePolling(reload, 120_000);
  return { overview, error, reload };
}
