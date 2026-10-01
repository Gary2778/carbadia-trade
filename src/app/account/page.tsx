"use client";
import Link from "next/link";
import { useState } from "react";
import { fmtMoney } from "@/lib/format";
import { accountActions, useAccountStatus, useMe } from "@/lib/market/account-store";
import { useExchangeText } from "@/components/exchange/useExchange";
import { DemoButton } from "@/components/exchange/AccountData";
import { ExchangeIcon } from "@/components/exchange/ExchangeIcon";
export default function AccountPage() {
  const c = useExchangeText();
  // 登录态与余额读共享的账户 store(Nav 挂载时拉的那份,换路径时节流刷新),不再自己拉 /api/auth/me。
  // SSR 与水合首帧 store 是 idle → 按「加载中」画,与原来 loaded 之前一致;/api/auth/me 瞬时失败时 store 先按未登录显示并自愈重试
  const me = useMe() ?? null,
    status = useAccountStatus(),
    loaded = status === "ready" || status === "anon",
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      // 经账户 store 登出:POST /api/auth/logout,成功后 store 清空并请求传输层重连(Nav 同一拍变成未登录)
      await accountActions.logout();
      // 整页回首页(保留原来的行为):其它页面各自的客户端缓存(轮询中的资产、订单)一并清掉
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
                  href="/register?returnTo=%2Ftrade%2Faccount"
                  className="ex-button primary"
                >
                  {c("Create account", "建立账户")}
                </Link>
                <Link
                  href="/login?returnTo=%2Ftrade%2Faccount"
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
