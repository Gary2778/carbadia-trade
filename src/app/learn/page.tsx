import type { Metadata } from "next";
import { CarbonEssentials } from "@/components/exchange/CarbonEssentials";

export const metadata: Metadata = {
  title: "Carbon credit essentials",
  description:
    "Learn the carbon credit lifecycle, understand vintage and credit quality, compare VCU and ACCU schemes, and practice in Carbadia's simulation.",
};
export default function LearnPage() {
  return <CarbonEssentials />;
}
