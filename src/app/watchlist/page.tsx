import { Suspense } from "react";
import { MarketPlace } from "@/components/exchange/MarketPlace";
export default function WatchlistPage() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          className="rounded-2xl border border-border bg-surface p-8 text-center text-muted shadow-card"
        >
          Loading watchlist…
        </div>
      }
    >
      <MarketPlace watchlistOnly />
    </Suspense>
  );
}
