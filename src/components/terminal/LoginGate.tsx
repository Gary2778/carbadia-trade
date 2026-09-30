"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { useT } from "@/i18n/LangProvider";
import { accountActions } from "@/lib/market/account-store";
import { terminalHref } from "@/lib/market/navigation";
import { postEnvelope, type PostOutcome } from "@/lib/market/order-submit";

export type LoginGateProps = { symbol: string };

/** 登录页链接:登录后经 safeReturnTo 回到 /trade/<symbol>(LoginGate 与下单 401 的登录入口共用) */
export const loginHrefFor = (symbol: string): string => `/login?returnTo=${encodeURIComponent(terminalHref(symbol))}`;

const DEMO_URL = "/api/auth/demo";

/** 演示账户开不出来时的说明:429 → toast.rateLimited(Retry-After 秒数,不给重试);其余一律 ui.error + 重试(服务端英文原文不上界面) */
export type DemoFailure = { kind: "rateLimited"; retryAfter: number } | { kind: "error" };

/** POST /api/auth/demo 的结果 → 失败说明;成功为 null。信封里的服务端原文(英文)不带出来 */
export function demoFailureOf(outcome: PostOutcome): DemoFailure | null {
  if (outcome.kind === "ok") return null;
  if (outcome.kind === "rejected" && outcome.status === 429 && outcome.retryAfter !== null) return { kind: "rateLimited", retryAfter: outcome.retryAfter };
  return { kind: "error" };
}

/** 失败说明走 ui/ErrorState(§4.5):限流只给等待秒数、不给重试;其余 ui.error + 重试 */
export function DemoFailureNotice({ failure, onRetry }: { failure: DemoFailure; onRetry: () => void }) {
  const t = useT("terminal");
  const ui = useT("ui");
  return failure.kind === "rateLimited" ? <ErrorState message={t.toast.rateLimited(failure.retryAfter)} /> : <ErrorState message={ui.error} onRetry={onRetry} />;
}

/**
 * 未登录时替换下单表单(计划 §3.1):登录链接带 returnTo=/trade/<symbol>(登录页经 safeReturnTo 回跳),
 * 另给一键演示账户入口 —— 与登录页 / DemoButton 同一个 POST /api/auth/demo,成功后 accountActions.hydrate()
 * 刷新共享账户 store(身份变化时它会请求 WS 重连),本组件随 status 变 ready 被表单替换,不整页跳转。
 * 终端内不用 .ex-* 类,所以不直接复用 AccountData 的 DemoButton;文案取 login 命名空间的既有键;错误态走 ui/ErrorState(§4.5)。
 */
export function LoginGate({ symbol }: LoginGateProps) {
  const t = useT("terminal");
  const tl = useT("login");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DemoFailure | null>(null);

  const handleDemo = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // postEnvelope 与 hydrate 都不抛错;try 只为保证 busy 一定复位
      const outcome = await postEnvelope(DEMO_URL, undefined);
      const failed = demoFailureOf(outcome);
      if (failed) setFailure(failed);
      else await accountActions.hydrate();
    } catch {
      setFailure({ kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-login-gate="" className="flex flex-col gap-panel rounded-panel border border-(--terminal-border) bg-(--terminal-panel-2) p-panel">
      <p className="text-t-sm text-muted">{t.order.loginBody}</p>
      <Link
        href={loginHrefFor(symbol)}
        className="inline-flex min-h-touch items-center justify-center rounded-control bg-accent px-3 text-t-base font-semibold text-background transition-colors duration-(--motion-fast) hover:bg-accent-strong focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-2"
      >
        {t.order.login}
      </Link>
      <button
        type="button"
        onClick={handleDemo}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex min-h-touch items-center justify-center rounded-control border border-(--terminal-border) px-3 text-t-sm font-medium text-foreground transition-colors duration-(--motion-fast) hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 lg:py-2"
      >
        {busy ? tl.demoStarting : tl.tryDemo}
      </button>
      <p className="text-t-xs text-muted-2">{tl.tryDemoHint}</p>
      {failure ? <DemoFailureNotice failure={failure} onRetry={() => void handleDemo()} /> : null}
    </div>
  );
}
