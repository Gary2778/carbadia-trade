"use client";

import { useState } from "react";
import { api } from "@/lib/http/client";
import { useT } from "@/i18n/LangProvider";

export default function FeedbackPage() {
  const t = useT("feedback");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/api/feedback", {
        method: "POST",
        body: JSON.stringify({ message, contact: contact || undefined }),
      });
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-10">
      <div className="rounded-panel border border-border bg-surface shadow-card p-6">
        <h1 className="text-lg font-bold mb-1">{t.title}</h1>
        {done ? (
          <p className="text-sm mt-4">{t.thanks}</p>
        ) : (
          <>
            <p className="text-muted text-sm mb-5">{t.intro}</p>
            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t.placeholder}
                  required
                  minLength={1}
                  maxLength={2000}
                  rows={5}
                  className="w-full mt-1 bg-surface-2 border border-border rounded-control px-3.5 py-2.5 text-sm outline-none focus:border-accent resize-none"
                />
              </label>
              <label className="block">
                <input
                  type="text"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder={t.contactLabel}
                  maxLength={200}
                  className="w-full mt-1 bg-surface-2 border border-border rounded-control px-3.5 py-2.5 text-sm outline-none focus:border-accent"
                />
              </label>
              {err && <div className="text-danger text-xs">{err}</div>}
              <button
                disabled={busy}
                className="w-full py-2.5 rounded-control bg-accent text-background font-medium hover:bg-accent-strong transition-colors disabled:opacity-40"
              >
                {busy ? t.sending : t.submit}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
