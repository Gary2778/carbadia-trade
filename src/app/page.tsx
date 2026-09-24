import { Suspense } from "react";
import { MarketPlace } from "@/components/exchange/MarketPlace";
import { ExchangePageHeader } from "@/components/exchange/ExchangePageHeader";
export default function ExchangePage() {
  return (
    <div className="space-y-10">
      <ExchangePageHeader />
      <Suspense
        fallback={
          <div
            role="status"
            className="rounded-2xl border border-border bg-surface p-8 text-center text-muted shadow-card"
          >
            Loading spot market…
          </div>
        }
      >
        <MarketPlace />
      </Suspense>
    </div>
  );
}
