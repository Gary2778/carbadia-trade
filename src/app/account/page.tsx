"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/http/client";
import { fmtMoney } from "@/lib/format";
import { useExchangeText } from "@/components/exchange/useExchange";
import { DemoButton } from "@/components/exchange/AccountData";
import { ExchangeIcon } from "@/components/exchange/ExchangeIcon";
export default function AccountPage() {
  const c = useExchangeText();
  const [me, setMe] = useState<{
      name: string;
      email: string;
      cashBalance: number;
      lockedCash: number;
    } | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<typeof me>("/api/auth/me")
      .then(setMe)
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);
  async function logout() {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      // 登出后整页重载是有意的:导航栏等客户端状态里还留着登录态,软导航清不掉
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <div className="ex-page-heading">
        <div>
          <h1>{c("Account & settings", "账户与设置")}</h1>
          <p>
            {c(
              "Your workspace, preferences and simulation balance.",
              "您的工作空间、偏好设置与模拟余额。",
            )}
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="ex-error">
          {error}
        </div>
      )}
      <div className="ex-two-column">
        <section className="ex-panel">
          <div className="ex-panel-heading">
            <h2>{c("Your account", "您的账户")}</h2>
            <ExchangeIcon name="account" />
          </div>
          {!loaded ? (
            <p role="status" className="ex-muted">
              {c("Loading…", "加载中…")}
            </p>
          ) : me ? (
            <>
              <dl className="grid gap-5 text-sm">
                <div>
                  <dt className="ex-muted">{c("Display name", "显示名称")}</dt>
                  <dd className="mt-1">{me.name}</dd>
                </div>
                <div>
                  <dt className="ex-muted">{c("Email", "邮箱")}</dt>
                  <dd className="mt-1 break-all">{me.email}</dd>
                </div>
                <div>
                  <dt className="ex-muted">
                    {c("Account environment", "账户环境")}
                  </dt>
                  <dd className="mt-1">
                    {c("Carbon-market simulator", "碳市场模拟环境")}
                  </dd>
                </div>
              </dl>
              <button
                className="ex-button mt-7"
                onClick={logout}
                disabled={busy}
              >
                {busy ? c("Signing out…", "退出登录中…") : c("Sign out", "退出登录")}
              </button>
            </>
          ) : (
            <>
              <p className="ex-muted mb-5">
                {c(
                  "Create an account to keep your trading and retirement history, or try an isolated demo workspace.",
                  "建立账户保留交易与注销记录，或使用专属模拟工作空间。",
                )}
              </p>
              <div className="ex-actions mb-5">
                <Link
                  href="/register?returnTo=%2Fportfolio"
                  className="ex-button primary"
                >
                  {c("Create account", "建立账户")}
                </Link>
                <Link
                  href="/login?returnTo=%2Fportfolio"
                  className="ex-button"
                >
                  {c("Sign in", "登录")}
                </Link>
              </div>
              <DemoButton />
            </>
          )}
        </section>
        <div>
          <section className="ex-panel" id="funding">
            <div className="ex-panel-heading">
              <h2>{c("Demo funding", "模拟资金")}</h2>
              <ExchangeIcon name="portfolio" />
            </div>
            <p className="ex-metric-big">
              {me ? `$${fmtMoney(me.cashBalance)}` : "—"}
            </p>
            <p className="ex-muted mt-2 mb-5">
              {c("Available simulated USD", "可用模拟美元")}
            </p>
            <p className="text-xs text-muted leading-relaxed">
              {c(
                "Real deposits and withdrawals are not supported. A new guest workspace starts with $100,000 in simulated funds. These funds have no monetary value.",
                "不支持真实入金或出金。新的体验工作空间提供 100,000 美元模拟资金，没有实际货币价值。",
              )}
            </p>
          </section>
          <section className="ex-panel">
            <h2>{c("Display preferences", "显示偏好")}</h2>
            <p className="ex-muted mt-3 leading-relaxed">
              {c(
                "Use the language and appearance controls in the top bar. Preferences and your watchlist are stored on this browser. Carbadia Trade is available in English and Simplified Chinese.",
                "使用顶部工具栏切换语言与明暗主题。偏好与关注列表存储于此浏览器。Carbadia Trade 提供英文与简体中文界面。",
              )}
            </p>
            <Link
              href="/learn#simulation"
              className="ex-learn-link mt-4"
            >
              {c("Understand the simulation", "了解模拟环境")}
              <ExchangeIcon name="arrow" size={14} />
            </Link>
          </section>
        </div>
      </div>
    </>
  );
}
