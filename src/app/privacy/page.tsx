import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Policy" };

const SECTIONS: [string, string][] = [
  ["1. What we collect", "Account data you provide (name, email, a salted password hash), the simulated trading activity your account generates (orders, trades, listings, simulated retirements), and any feedback you submit through the feedback form (your message and, if you choose, a contact address). First-party product analytics record anonymous page views and funnel events (an opaque visitor id in a cookie; no cross-site tracking)."],
  ["2. What we do not collect", "No payment data (there are no payments), no government IDs, no third-party trackers, no advertising identifiers."],
  ["3. How data is used", "To operate the simulation, keep you signed in (session cookie), respond to feedback, and understand aggregate product usage. We do not sell or share personal data."],
  ["4. Cookies and local storage", "cx_session keeps you signed in; cx_vid is an anonymous visitor id for first-party analytics. Display preferences stay in this browser's local storage: carbadia-theme (light or dark), carbadia-lang (language), carbadia-updown (whether green or red marks a rising price) and carbadia-terminal-prefs (the trading terminal's chart interval, order-book grouping and depth, bottom tab, indicators and last symbol); carbadia-credit-watchlist keeps your watchlist on this browser. The terminal pages use the dark look until you pick one yourself; that default is derived from the page you are on and is not written to local storage."],
  ["5. Retention and deletion", "Simulated market history is pruned routinely. To delete your account and its data, email hello@carbadia.io from the registered address."],
  ["6. Contact", "Privacy questions: hello@carbadia.io."],
];

export default function PrivacyPage() {
  return (
    <article className="max-w-2xl mx-auto py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Privacy Policy</h1>
        <p className="text-muted text-xs mt-2">Last updated: 2026-09 · The English version is canonical.</p>
      </header>
      {SECTIONS.map(([h, body]) => (
        <section key={h}>
          <h2 className="font-semibold text-sm mb-1">{h}</h2>
          <p className="text-muted text-sm leading-relaxed">{body}</p>
        </section>
      ))}
    </article>
  );
}
