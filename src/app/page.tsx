import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketPlace } from "@/components/exchange/MarketPlace";
import { ExchangePageHeader } from "@/components/exchange/ExchangePageHeader";

// 规范网址只写在首页:写进根 layout 会被所有没自己声明的页面继承,全站都指回首页;?sort= 之类的查询串也归到这里
export const metadata: Metadata = { alternates: { canonical: "/" } };

// 品牌结构化数据:站点名「Carbadia Trade」(Google 只从首页的 WebSite 读站点名),发布方是 carbadia.io 上同一个
// Organization(@id 与主站首页那条一致,Google 能把两个站认成同一个品牌)。
const BRAND_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://cbda.trade/#website",
      name: "Carbadia Trade",
      url: "https://cbda.trade",
      publisher: { "@id": "https://carbadia.io/#organization" },
    },
    {
      "@type": "Organization",
      "@id": "https://carbadia.io/#organization",
      name: "Carbadia",
      url: "https://carbadia.io",
      logo: "https://carbadia.io/apple-icon.png",
    },
  ],
};

export default function ExchangePage() {
  return (
    <div className="space-y-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(BRAND_JSON_LD).replace(/</g, "\\u003c") }} />
      <ExchangePageHeader />
      {/* 行情表在客户端拉数据(useSearchParams 让这一段在静态预渲染里退回客户端渲染),首帧只有这个占位:
          占位至少一屏高,页脚从第一帧起就在首屏之外,表格长出来时不把页脚从视口里推走(移动 CLS 0.406 的来源,P1-25f);
          SpotTable 的加载态同样留足一屏 */}
      <Suspense
        fallback={
          <div
            role="status"
            className="min-h-svh rounded-panel border border-border bg-surface p-8 text-center text-muted shadow-card"
          >
            Loading spot market…
          </div>
        }
      >
        <MarketPlace />
      </Suspense>
    </div>
  );
}
