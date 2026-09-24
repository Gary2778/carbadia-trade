"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { api, ApiError } from "@/lib/http/client";
import { usePolling } from "@/hooks/usePolling";
import { ExchangeIcon } from "./ExchangeIcon";
import { useExchangeText } from "./useExchange";
export type Position = {
  assetId: string;
  symbol: string;
  name: string;
  registry: string;
  standard: string;
  vintage: number;
  country: string;
  projectType: string;
  isScenario: boolean;
  quantity: number;
  locked: number;
  available: number;
  lastPrice: number | null;
  marketValue: number;
  costBasis: number | null;
  averagePurchasePrice: number | null;
  unrealisedPnl: number | null;
  costBasisComplete: boolean;
  valuationComplete: boolean;
};
export type AccountPortfolio = {
  cashBalance: number;
  lockedCash: number;
  holdingsValue: number;
  totalAssets: number;
  heldCredits: number;
  retiredCredits: number;
  unrealisedPnl: number | null;
  valuationComplete: boolean;
  change24h: null;
  positions: Position[];
  openOrders: {
    id: string;
    side: string;
    type: string;
    price: number | null;
    quantity: number;
    filledQuantity: number;
    status: string;
    asset: { symbol: string; name: string };
  }[];
  trades: {
    id: string;
    direction: string;
    quantity: number;
    price: number;
    createdAt: string;
    asset: { symbol: string; name: string };
  }[];
  otcListings: {
    id: string;
    quantity: number;
    pricePerUnit: number;
    asset: { symbol: string; name: string };
  }[];
};
export function usePortfolio() {
  const [data, setData] = useState<AccountPortfolio | null>(null);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ticket = useRef(0);
  const expireSession = useCallback(() => {
    ticket.current += 1;
    setData(null);
    setUnauthorized(true);
    setLoaded(true);
  }, []);
  const reload = useCallback(async () => {
    const request = ++ticket.current;
    try {
      const result = await api<AccountPortfolio>("/api/portfolio");
      if (request !== ticket.current) return;
      setData(result);
      setError("");
      setUnauthorized(false);
    } catch (e) {
      if (request === ticket.current) {
        setError((e as Error).message);
        if (e instanceof ApiError && e.status === 401) {
          setData(null);
          setUnauthorized(true);
        }
      }
      throw e;
    } finally {
      if (request === ticket.current) setLoaded(true);
    }
  }, []);
  usePolling(reload, 7000);
  return { data, error, unauthorized, loaded, reload, expireSession };
}
export function DemoButton({
  returnTo = "/portfolio",
}: {
  returnTo?: string;
}) {
  const c = useExchangeText();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function start() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/demo", { method: "POST" });
      window.location.assign(returnTo);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="ex-button primary" onClick={start} disabled={busy}>
        {busy
          ? c("Creating your workspace…", "正在建立工作空间…")
          : c("Try with demo funds", "使用模拟资金体验")}
        <ExchangeIcon name="arrow" size={14} />
      </button>
      {error && (
        <p role="alert" className="text-down text-xs mt-3 max-w-sm">
          {error}
        </p>
      )}
    </div>
  );
}
export function AccountGate({
  error,
  loading,
  unauthorized,
  retry,
  returnTo = "/portfolio",
}: {
  error: string;
  loading: boolean;
  unauthorized: boolean;
  retry: () => Promise<unknown>;
  returnTo?: string;
}) {
  const c = useExchangeText();
  if (loading)
    return (
      <div className="ex-panel ex-loading" role="status">
        {c("Loading your account…", "加载账户中…")}
      </div>
    );
  if (unauthorized)
    return (
      <div className="ex-panel ex-empty">
        <ExchangeIcon name="portfolio" size={35} />
        <h2>{c("Your carbon journey starts here", "从这里打开碳信用之旅")}</h2>
        <p>
          {c(
            "Sign in to see your credits, orders and retirement records. Or explore with a private demo account and $100,000 in simulated funds.",
            "登录查看信用、订单与注销记录，或使用专属体验账户及 100,000 美元模拟资金。",
          )}
        </p>
        <div className="ex-actions justify-center">
          <DemoButton returnTo={returnTo} />
          <Link
            className="ex-button"
            href={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          >
            {c("Sign in", "登录")}
          </Link>
        </div>
      </div>
    );
  return (
    <div className="ex-error" role="alert">
      <span>
        {error || c("Account data is unavailable.", "账户数据无法使用。")}
      </span>
      <button onClick={() => void retry().catch(() => {})}>
        {c("Retry", "重试")}
      </button>
    </div>
  );
}
