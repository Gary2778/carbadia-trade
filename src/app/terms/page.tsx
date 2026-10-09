import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of Service", alternates: { canonical: "/terms" } };

const SECTIONS: [string, string][] = [
  ["1. What Carbadia Trade is", "Carbadia Trade (cbda.trade) is a simulation of carbon-credit trading operated by Carbadia (carbadia.io). It holds no financial license, conducts no real trading, clearing, or settlement, and its instruments, prices, and market data are fictional. No real funds or carbon assets are handled anywhere on this site."],
  ["2. Demo funds and accounts", "Balances shown on Carbadia Trade (including the $100,000 granted at sign-up) are simulated numbers with no monetary value. They cannot be deposited, withdrawn, redeemed, or transferred outside the simulation. Accounts may be reset or removed as part of operating the demo."],
  ["3. Simulated retirements", "A simulated retirement records that credits were removed from a demo account. It is not a registry retirement, confers no offset claim, and cannot be used to substantiate any emissions statement."],
  ["4. No advice", "Nothing on this site constitutes investment, financial, legal, or tax advice. Registry figures shown on the Projects and Market data pages come from public datasets via carbadia.io, are provided for reference only, and are not real-time."],
  ["5. Third-party names and data", "Verra, Gold Standard, UNFCCC, CCER and other standard or registry names are referenced for identification only. Registry figures come from public datasets such as CarbonPlan OffsetsDB and remain subject to their sources' terms. Carbadia is not affiliated with, endorsed by, or connected to any of these organizations."],
  ["6. Acceptable use", "Do not abuse the service (automated scraping beyond reasonable use, attacks, attempts to disrupt the simulation). We may suspend accounts that do."],
  ["7. Availability and data", "The service is provided as-is, with no uptime or data-retention guarantees. Simulated trading history may be pruned as part of routine maintenance."],
  ["8. Changes", "These terms may change as the product evolves; the version published at cbda.trade/terms applies."],
  ["9. Contact", "Questions: hello@carbadia.io."],
];

export default function TermsPage() {
  return (
    <article className="max-w-2xl mx-auto py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Terms of Service</h1>
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
