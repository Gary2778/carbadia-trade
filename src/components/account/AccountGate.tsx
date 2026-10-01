"use client";

import { useState } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui/ErrorState";
import { useT } from "@/i18n/LangProvider";
import { accountActions } from "@/lib/market/account-store";
import { PANEL, SECONDARY_BUTTON } from "./styles";

/** 资产页自己的地址:登录 / 注册之后经 safeReturnTo 回到这里 */
export const ACCOUNT_PAGE_HREF = "/trade/account";
const RETURN_TO = `returnTo=${encodeURIComponent(ACCOUNT_PAGE_HREF)}`;
const DEMO_URL = "/api/auth/demo";

/** 演示账户开不出来时的说明(与终端 LoginGate 的 DemoFailure 同形):429 → 等待秒数、不给重试;其余一律 ui.error + 重试 */
export type DemoFailure = { kind: "rateLimited"; retryAfter: number } | { kind: "error" };

/**
 * POST /api/auth/demo → 成功为 null,否则失败说明;从不抛错。规则与终端 LoginGate(demoFailureOf ∘ postEnvelope)相同:
 * 2xx 且信封 ok → 成功;429 带 Retry-After → 等待秒数;断网、5xx、别的 4xx、信封不对 → 一律 error(服务端的英文原文不上界面)。
 * 不直接引 LoginGate / order-submit:那两个模块是终端首屏的一部分,资产页一引,它们就成了两页共享的模块,
 * 终端首屏的包因此变大(终端页自有包的预算只剩几百字节,见报告)。fetchImpl 可注入(测试)。
 */
export async function requestDemoAccount(fetchImpl: typeof fetch = fetch): Promise<DemoFailure | null> {
  let res: Response;
  try {
    res = await fetchImpl(DEMO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store" });
  } catch {
    return { kind: "error" };
  }
  const envelope: unknown = await res.json().catch(() => null);
  if (res.ok && typeof envelope === "object" && envelope !== null && (envelope as { ok?: unknown }).ok === true) return null;
  const header = res.headers.get("Retry-After");
  const retryAfter = header === null || header.trim() === "" ? NaN : Number(header);
  if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0) return { kind: "rateLimited", retryAfter: Math.ceil(retryAfter) };
  return { kind: "error" };
}

/**
 * 未登录(计划 §6.2.3 P2-10):一句标题 + 一键演示账户 + 登录 / 注册(returnTo=/trade/account)。
 * 演示账户与终端的 LoginGate 同一个 POST /api/auth/demo、同一套失败说明(requestDemoAccount:429 给等待秒数,其余 ui.error + 重试);
 * 成功后 accountActions.hydrate() 刷新共享账户 store(身份变化时它会请求 WS 重连),本组件随 status 变 ready 被数据替换,不整页跳转。
 * 文字刻意比页头的说明短:页头是首屏的 LCP 元素,水合之后才出现的这一块不该比它大。
 */
export function AccountGate() {
  const a = useT("account");
  const nav = useT("nav");
  const tl = useT("login");
  const t = useT("terminal");
  const ui = useT("ui");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DemoFailure | null>(null);

  const handleDemo = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const failed = await requestDemoAccount();
      if (failed) setFailure(failed);
      else await accountActions.hydrate();
    } catch {
      setFailure({ kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-account-gate="" aria-labelledby="account-gate-title" className={`flex flex-col items-start gap-panel p-panel ${PANEL}`}>
      <h2 id="account-gate-title" className="text-t-md font-semibold text-foreground">
        {a.gate.title}
      </h2>
      <div className="flex flex-wrap gap-gap">
        <button
          type="button"
          onClick={handleDemo}
          disabled={busy}
          aria-busy={busy}
          className="inline-flex min-h-touch items-center justify-center rounded-control bg-accent px-4 text-t-sm font-semibold text-background transition-colors duration-(--motion-fast) hover:bg-accent-strong focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 lg:py-2"
        >
          {busy ? tl.demoStarting : tl.tryDemo}
        </button>
        <Link href={`/login?${RETURN_TO}`} className={SECONDARY_BUTTON}>
          {nav.login}
        </Link>
        <Link href={`/register?${RETURN_TO}`} className={SECONDARY_BUTTON}>
          {nav.register}
        </Link>
      </div>
      <p className="text-t-xs text-muted-2">{tl.tryDemoHint}</p>
      {failure ? (
        failure.kind === "rateLimited" ? <ErrorState message={t.toast.rateLimited(failure.retryAfter)} /> : <ErrorState message={ui.error} onRetry={() => void handleDemo()} />
      ) : null}
    </section>
  );
}
