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
// data-theme 是 "light" | "dark"(readTheme);没存过外观时 /trade 前缀按 dark(defaultThemeFor:派生值,不写 localStorage);
// 涨跌轴 carbadia-updown 只认 "red-up",其余 green-up(readUpDown),写成 data-updown。
// 迁移:儿童护眼模式 2026-09-30 下线(P1-27),开过它的访客留着旧键 carbadia-kids,这里删掉;外观按 carbadia-theme(没有则按上面的首访规则),
// 与 ThemeProvider 挂载后算出的一致,不闪、不水合失配。删除单独包一层 try:存储不可用时不影响上面已写好的属性。
const THEME_INIT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("carbadia-theme");if(t!=="light"&&t!=="dark")t=(t===null&&location.pathname.indexOf("/trade")===0)?"dark":"light";d.setAttribute("data-theme",t);d.style.colorScheme=t;var u=localStorage.getItem("carbadia-updown");d.setAttribute("data-updown",u==="red-up"?"red-up":"green-up");}catch(e){}try{localStorage.removeItem("carbadia-kids");}catch(e){}})()`;

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
