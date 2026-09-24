import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Your simulated holdings, orders and trade history.",
};

export default function PortfolioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
