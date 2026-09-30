"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { InstrumentListItem } from "@/shared";
import { useT } from "@/i18n/LangProvider";
import { siblingsByProject } from "@/lib/market/instrument-filter";
import { switchSymbol, terminalHref } from "@/lib/market/navigation";
import { useMarketStore } from "@/lib/market/store";
import { opensElsewhere } from "./InstrumentRow";

export type VintageSelectorProps = {
  /** 当前标的的 projectId(SIM-PRJ-<STANDARD>-<TYPE>);null → 未知项目,不列任何 chip */
  projectId: string | null;
  /** 当前标的代码:它自己不出 chip */
  current: string;
  /** SSR 注入的全部标的:store 尚未灌入时从它找兄弟标的(首屏标记只来自 props) */
  initialItems: InstrumentListItem[];
};

/**
 * 头部的同项目 vintage 选择器(计划 §3.1):同 projectId 的其它 vintage 各一个年份 chip,点击 switchSymbol
 * (replaceState 换标的,不走 RSC、不重挂载终端壳);chip 是指向 /trade/<symbol> 的普通 <a>,新标签页打开仍是完整深链。
 * 情景标的不参与(siblingsByProject 排除);项目只有当前一个 vintage 时不渲染任何东西。
 *
 * 数据:只订阅 store 的 instruments 切片(标的元数据;ticker 刷新不换它的引用,所以行情跳动不重渲染头部的这组 chip),
 * store 空(服务端与水合首帧)时用 initialItems —— 与计划写的 useInstrumentList({}, initialItems) 同一来源,少一份逐 tick 的重算。
 *
 * 焦点:换标的后,被点的 chip 变成「当前」而从列表里消失;effect 把焦点交给刚换出去的那个 vintage 的 chip,
 * 键盘用户不会掉回 <body>(鼠标点击后的程序化聚焦不显示焦点环)。
 */
export const VintageSelector = memo(function VintageSelector({ projectId, current, initialItems }: VintageSelectorProps) {
  const t = useT("terminal");
  const storedInstruments = useMarketStore((s) => (s.instrumentsVersion === 0 ? undefined : s.instruments));
  const siblings = useMemo(
    () => siblingsByProject(storedInstruments ? Object.values(storedInstruments) : initialItems.map((item) => item.instrument), projectId, current),
    [storedInstruments, initialItems, projectId, current],
  );

  const navRef = useRef<HTMLElement>(null);
  const refocusSymbol = useRef<string | null>(null);
  useEffect(() => {
    const target = refocusSymbol.current;
    if (target === null) return;
    refocusSymbol.current = null;
    navRef.current?.querySelector<HTMLAnchorElement>(`a[data-symbol="${target}"]`)?.focus();
  }, [current]);

  if (siblings.length === 0) return null;

  return (
    <nav ref={navRef} aria-label={t.instruments.vintages} data-vintage-selector="" className="flex min-w-0 flex-wrap items-center gap-1">
      <span aria-hidden="true" className="text-t-2xs text-muted-2 max-md:hidden">
        {t.instruments.vintages}
      </span>
      {siblings.map((ins) => (
        <a
          key={ins.symbol}
          href={terminalHref(ins.symbol)}
          data-symbol={ins.symbol}
          aria-label={ins.symbol}
          title={ins.symbol}
          onClick={(e) => {
            if (opensElsewhere(e)) return;
            e.preventDefault();
            refocusSymbol.current = current;
            switchSymbol(ins.symbol);
          }}
          className="tnum inline-flex h-6 items-center rounded-chip border border-(--terminal-border) px-1.5 text-t-xs text-muted transition-colors duration-(--motion-fast) hover:bg-(--terminal-row-hover) hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus pointer-coarse:min-h-touch max-lg:min-h-touch"
        >
          {ins.vintage}
        </a>
      ))}
    </nav>
  );
});
