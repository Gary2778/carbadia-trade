import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OTC Listings",
  description: "Simulated over-the-counter block carbon-credit listings — sellers list, buyers fill directly.",
};

export default function OtcLayout({ children }: { children: React.ReactNode }) {
  return children;
}
