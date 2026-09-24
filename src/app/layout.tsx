import type { Metadata } from "next";
import "./globals.css";
import "./exchange.css";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { ToastProvider } from "@/components/anim/Toast";
import { MotionProvider } from "@/components/anim/MotionProvider";
import { LangProvider } from "@/i18n/LangProvider";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { StarfieldCanvas } from "@/components/StarfieldCanvas";
import { StarrySky } from "@/components/StarrySky";
import { LiquidGlassRefraction } from "@/components/LiquidGlassRefraction";
import { TrackPageviews } from "@/components/TrackPageviews";
import { ExchangeSectionNav } from "@/components/exchange/ExchangeSectionNav";

export const metadata: Metadata = {
  metadataBase: new URL("https://cbda.trade"),
  title: { default: "Carbadia Trade · A carbon credit trading simulator", template: "%s · Carbadia Trade" },
  description:
    "Trade carbon credits like it's real. Order-book matching, OTC listings, portfolios and simulated retirements with $100,000 in demo funds. No real money, no real carbon. Part of Carbadia (carbadia.io).",
  openGraph: {
    siteName: "Carbadia Trade",
    type: "website",
    url: "https://cbda.trade",
  },
  twitter: { card: "summary_large_image" },
};

// 首帧绘制前按 localStorage 纠正外观,避免闪烁(默认浅色)。与 providers/themeState.ts 同一套规则:
// data-theme 只表示色系;儿童护眼模式(carbadia-kids = "1")属于深色系,再多挂一个 data-kids。
const THEME_INIT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("carbadia-theme");if(t!=="light"&&t!=="dark")t="light";if(localStorage.getItem("carbadia-kids")==="1"){t="dark";d.setAttribute("data-kids","true");}d.setAttribute("data-theme",t);d.style.colorScheme=t;}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeProvider>
          <LangProvider>
            <MotionProvider>
              <ToastProvider>
                <StarfieldCanvas />
                <StarrySky />
                <LiquidGlassRefraction />
                <TrackPageviews />
                <Nav />
                <main className="flex-1 w-full max-w-7xl mx-auto px-5 py-8">
                  <div className="exchange-content">
                    <ExchangeSectionNav />
                    {children}
                  </div>
                </main>
                <Footer />
              </ToastProvider>
            </MotionProvider>
          </LangProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
