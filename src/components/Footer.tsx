"use client";

import Link from "next/link";
import { ContactEmail } from "@/components/ContactEmail";
import { useT } from "@/i18n/LangProvider";

const CARBADIA_HOME = "https://carbadia.io";

export function Footer() {
  const t = useT("footer");
  return (
    <footer className="border-t border-border text-muted text-xs py-6 px-5">
      <div className="max-w-3xl mx-auto text-center space-y-2">
        <p>{t.brand}</p>
        <p className="space-x-3">
          <Link href="/terms" className="hover:text-foreground transition-colors">{t.termsLink}</Link>
          <span aria-hidden>·</span>
          <Link href="/privacy" className="hover:text-foreground transition-colors">{t.privacyLink}</Link>
          <span aria-hidden>·</span>
          <Link href="/feedback" className="hover:text-foreground transition-colors">{t.feedbackLink}</Link>
          <span aria-hidden>·</span>
          <a href={CARBADIA_HOME} rel="noopener" className="hover:text-foreground transition-colors whitespace-nowrap">
            carbadia.io<span aria-hidden> ↗</span>
          </a>
        </p>
        <p>
          {t.contact}
          <ContactEmail className="text-accent hover:underline" />
        </p>
        <p className="leading-relaxed">{t.disclaimer}</p>
      </div>
    </footer>
  );
}
