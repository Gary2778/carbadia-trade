"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/http/client";
import { safeReturnTo } from "@/lib/redirects";
import { useT } from "@/i18n/LangProvider";
import { Input } from "../login/page";

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const t = useT("register");
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = safeReturnTo(sp.get("returnTo"));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/api/auth/register", { method: "POST", body: JSON.stringify({ email, name, password }) });
      router.push(returnTo);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-10">
      <div className="rounded-2xl border border-border bg-surface shadow-card p-6">
        <h1 className="text-lg font-bold mb-1">{t.title}</h1>
        <p className="text-muted text-sm mb-5">{t.subtitle}</p>
        <form onSubmit={submit} className="space-y-3">
          <Input label={t.nameLabel} type="text" value={name} onChange={setName} placeholder={t.namePlaceholder} />
          <Input label={t.emailLabel} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
          <Input label={t.passwordLabel} type="password" value={password} onChange={setPassword} placeholder={t.passwordPlaceholder} />
          {err && <div className="text-down text-xs">{err}</div>}
          <label className="flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" required className="mt-0.5 accent-current" />
            <span>
              {t.agreePre}
              <Link href="/terms" className="text-accent" target="_blank">{t.agreeTerms}</Link>
              {t.agreeAnd}
              <Link href="/privacy" className="text-accent" target="_blank">{t.agreePrivacy}</Link>
            </span>
          </label>
          <button disabled={busy} className="w-full py-2.5 rounded-full bg-accent text-background font-medium hover:bg-accent-strong transition-colors disabled:opacity-40">
            {busy ? t.submitting : t.submit}
          </button>
        </form>
        <div className="text-sm text-muted mt-4 text-center">
          {t.haveAccount}<Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="text-accent">{t.login}</Link>
        </div>
      </div>
    </div>
  );
}
