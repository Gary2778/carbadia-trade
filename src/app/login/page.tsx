"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/http/client";
import { accountActions } from "@/lib/market/account-store";
import { safeReturnTo } from "@/lib/redirects";
import { useT } from "@/i18n/LangProvider";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useT("login");
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = safeReturnTo(sp.get("returnTo"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [demoBusy, setDemoBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      // 跳转前刷新共享的账户 store:Nav 与终端立即看到新身份与余额(不抛错;身份变化时会请求 WS 重连)。
      // 最多等 AUTH_NAVIGATE_WAIT_MS:请求挂住时照样跳转,hydrate 在后台继续,失败由 Nav 的自愈重试补上
      await accountActions.hydrateForNavigation();
      router.push(returnTo);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function startDemo() {
    setDemoBusy(true); setErr("");
    try {
      await api("/api/auth/demo", { method: "POST" });
      // 跳转前刷新共享的账户 store:Nav 与终端立即看到新身份与余额(不抛错;身份变化时会请求 WS 重连)。
      // 最多等 AUTH_NAVIGATE_WAIT_MS:请求挂住时照样跳转,hydrate 在后台继续,失败由 Nav 的自愈重试补上
      await accountActions.hydrateForNavigation();
      router.push(returnTo);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setDemoBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-10">
      <div className="rounded-2xl border border-border bg-surface shadow-card p-6">
        <h1 className="text-lg font-bold mb-1">{t.title}</h1>
        <p className="text-muted text-sm mb-5">{t.subtitle}</p>
        <form onSubmit={submit} className="space-y-3">
          <Input label={t.email} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
          <Input label={t.password} type="password" value={password} onChange={setPassword} placeholder="••••••" />
          {err && <div className="text-danger text-xs">{err}</div>}
          <button disabled={busy} className="w-full py-2.5 rounded-full bg-accent text-background font-medium hover:bg-accent-strong transition-colors disabled:opacity-40">
            {busy ? t.loggingIn : t.login}
          </button>
        </form>
        <div className="text-sm text-muted mt-4 text-center">
          {t.noAccount}<Link href={`/register?returnTo=${encodeURIComponent(returnTo)}`} className="text-accent">{t.signUp}</Link>
        </div>
        <div className="mt-4 pt-4 border-t border-border space-y-2">
          <button
            type="button"
            disabled={demoBusy}
            onClick={startDemo}
            className="w-full py-2.5 rounded-full bg-surface-2 border border-border text-sm font-medium hover:bg-border/60 transition-colors disabled:opacity-40"
          >
            {demoBusy ? t.demoStarting : t.tryDemo}
          </button>
          <p className="text-xs text-muted text-center">{t.tryDemoHint}</p>
        </div>
      </div>
    </div>
  );
}

export function Input({ label, type, value, onChange, placeholder }: {
  label: string; type: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required
        className="w-full mt-1 bg-surface-2 border border-border rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-accent"
      />
    </label>
  );
}
