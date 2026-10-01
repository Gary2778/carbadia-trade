"use client";
// 旧页面(/orders、/transactions、/account)共用的登录入口与演示账户按钮。原来的 usePortfolio(轮询 /api/portfolio)随旧 /portfolio、
// /dashboard 一起删了(P2-10:资产页 /trade/account 取代它们,数据走 /api/account/overview 与账户 store);默认回跳也改成新页。
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/http/client";
import { ExchangeIcon } from "./ExchangeIcon";
import { useExchangeText } from "./useExchange";
export function DemoButton({
  returnTo = "/trade/account",
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
        <p role="alert" className="text-danger text-xs mt-3 max-w-sm">
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
  returnTo = "/trade/account",
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
