import type { Metadata } from "next";
import { ExchangeResearch } from "@/components/exchange/ExchangeResearch";

export const metadata: Metadata = {
  title: "Carbon market research",
  description:
    "Explore sourced registry issuance and retirement activity alongside clearly identified Carbadia simulation data.",
};
export default function ResearchPage() {
  return <ExchangeResearch />;
}
