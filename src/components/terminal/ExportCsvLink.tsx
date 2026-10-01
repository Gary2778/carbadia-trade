"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 历史委托页签的 CSV 导出(计划 §6.2.2 C5):与该页签同一组筛选(status=history),不带 limit / cursor。
 * 放在这里而不在 OrderHistoryTab(那里再导出):BottomTabs 在手机上把入口并进页签条,要静态引用它,
 * 而页签本身是 next/dynamic 按需加载的,不能因为一个常量被拉进终端首屏。
 */
export const HISTORY_CSV_HREF = "/api/account/orders.csv?status=history";
/** 成交记录页签的 CSV 导出:该页签没有筛选,导出本人全部成交(放在这里的原因同上) */
export const FILLS_CSV_HREF = "/api/account/fills.csv";

/**
 * 页签条一格的下边框(选中 tab 的下划线;入口的是透明的),与 compact 入口命中区向下伸出的量绑在一起:
 * 绝对定位量的是内边距盒,命中区要先伸过这条边框、再伸过页签条与表格之间的间隙(gap),才正好填满间隙。
 * Tailwind 只认源码里写全的类名,两个类不能由一个数字拼出来,所以成对写在这一处:border 是 border-b-2(2 px = 0.125rem),
 * hitBelow 里加的就是 0.125rem。改边框宽度时两个一起改;tabs.ssr.test.ts 按 border-b-N ↔ N/16 rem 核对二者一致。
 */
export const STRIP_RULE = {
  border: "border-b-2",
  hitBelow: "before:-bottom-[calc(var(--spacing-gap)+0.125rem)]",
} as const;

/**
 * 页签条里一格的纵向盒子:底部页签的 tab 与手机上并进页签条的导出入口共用(P2-12)。行高、下内边距、2 px 下边框(STRIP_RULE,
 * -mb-px 压在页签条的底线上)都一样,入口的字号又不大于 tab 的(text-t-xs ≤ text-t-sm),所以入口出现与否页签条都一样高、
 * 文字底边对齐 —— 切到历史委托 / 成交记录时 tab 不往下跳。
 */
export const STRIP_ITEM_BOX = `-mb-px ${STRIP_RULE.border} pb-gap leading-t-tight`;

/**
 * CSV 导出入口(计划 §6.2.2 C5,P2-06):带 download 属性的普通链接,浏览器自己下载,文件名取响应的 Content-Disposition。
 * 不用 fetch + Blob:大文件不进页面内存,服务端流式写、浏览器边收边存。
 * href 带着页签当前的筛选(与该页签的 JSON 查询同一组参数,不带 cursor / limit)。
 * 只放在登录后才挂载的页签里(BottomTabs 在账户状态 ready 之前不挂页签),所以未登录不会看到它。
 * 与流水页签的筛选下拉同高(手机上是触控高度),三个页签的工具行一样高。
 * compact:手机上并进页签条时用(BottomTabs,P2-12):不是带边框的小按钮,而是与 tab 同一个纵向盒子(STRIP_ITEM_BOX)的文字链接,
 * 页签条不因它变高。可见的盒子与 tab 一样高;命中区用 before 伪元素往外伸,只伸进旁边没有可点东西的空白:向上伸进面板的上内边距
 * (panel),向下伸进页签条与表格之间的间隙(gap),左右各伸一个 gap(左边正好是外层的 ps-gap,右边是面板的右内边距)。
 * 绝对定位量的是内边距盒:下沿要再加上 STRIP_ITEM_BOX 那条下边框,伸出的部分才正好填满间隙 —— 下沿的类(STRIP_RULE.hitBelow)
 * 与边框的类(STRIP_RULE.border)成对定义在上面。
 * 命中区约 35 px 高、比可见的盒子宽 2 个 gap(375 宽实测 35.2 px,见 P2-12 报告),高于 WCAG 2.5.8 的 24 px;再往下就压到表格上了,所以没有做到 44 px。
 */
export function ExportCsvLink({ href, filtered = false, compact = false }: { href: string; filtered?: boolean; compact?: boolean }) {
  const t = useT("terminal");
  return (
    <a
      href={href}
      download
      data-export-csv=""
      title={filtered ? t.exportCsv.hintFiltered : t.exportCsv.hint}
      className={
        compact
          ? `relative inline-flex shrink-0 items-center ${STRIP_ITEM_BOX} border-transparent px-1.5 text-t-xs font-medium text-accent before:absolute before:-inset-x-gap ${STRIP_RULE.hitBelow} before:-top-panel hover:underline focus-visible:outline-none focus-visible:shadow-focus`
          : "inline-flex shrink-0 items-center rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-2 text-t-xs font-medium text-foreground hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus min-h-touch lg:min-h-0 lg:py-0.5"
      }
    >
      {t.exportCsv.label}
    </a>
  );
}

/**
 * 没有筛选条的页签(历史委托、成交记录)的工具行:导出入口靠右。只在 ≥ 48rem 显示;手机上这一行会挤掉表格约两行,
 * 入口改由 BottomTabs 并进页签条右端(stripExportHref,P2-12)。
 */
export function ExportCsvBar({ href }: { href: string }) {
  return (
    <div className="hidden shrink-0 items-center justify-end p-0.5 md:flex">
      <ExportCsvLink href={href} />
    </div>
  );
}
