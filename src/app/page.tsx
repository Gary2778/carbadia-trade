import { Suspense } from "react";
import { MarketPlace } from "@/components/exchange/MarketPlace";
import { ExchangePageHeader } from "@/components/exchange/ExchangePageHeader";
export default function ExchangePage() {
  return (
    <div className="space-y-10">
      <ExchangePageHeader />
      {/* 行情表在客户端拉数据(useSearchParams 让这一段在静态预渲染里退回客户端渲染),首帧只有这个占位:
          占位至少一屏高,页脚从第一帧起就在首屏之外,表格长出来时不把页脚从视口里推走(移动 CLS 0.406 的来源,P1-25f);
          SpotTable 的加载态同样留足一屏 */}
      <Suspense
        fallback={
          <div
            role="status"
            className="min-h-svh rounded-2xl border border-border bg-surface p-8 text-center text-muted shadow-card"
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
