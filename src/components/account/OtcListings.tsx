"use client";

import { memo, useCallback, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import type { OtcListingView } from "@/shared";
import { useToast } from "@/components/anim/Toast";
import { tName } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { ApiError, api } from "@/lib/http/client";
import { accountActions } from "@/lib/market/account-store";
import type { PositionMeta } from "@/lib/market/position-groups";
import { localeOf, tonnes, usd } from "./format";
import { PANEL, PANEL_TITLE, SECONDARY_BUTTON } from "./styles";

/** 撤牌:DELETE /api/otc/{id}(已有接口,信封 { ok, data });成功后锁定数量由服务端的 position 事件更新(P2-03) */
export const otcListingUrl = (id: string): string => `/api/otc/${encodeURIComponent(id)}`;

export type OtcListingRowProps = {
  id: string;
  symbol: string;
  name: string;
  pricePerUnit: number;
  quantity: number;
  minQuantity: number;
  precision: number;
  /** 两步撤牌的第一步已按下:同一个按钮变成「确认下架」,旁边多一个「保留」 */
  armed: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
  onKeep: () => void;
};

/** 一条挂牌(React.memo + 原始类型 props):标的 | 单价 | 可售 | 最小成交量 | 下架(两步) */
export const OtcListingRow = memo(function OtcListingRow(p: OtcListingRowProps) {
  const a = useT("account");
  const { lang } = useLang();
  const locale = localeOf(lang);
  const cell = "flex min-w-0 flex-col lg:items-end lg:text-end";
  const label = "text-t-xs text-muted lg:sr-only";
  return (
    <li data-listing-id={p.id} className="t-otc-grid grid items-center border-t border-(--terminal-border) px-panel py-2 first:border-t-0 hover:bg-(--terminal-row-hover)">
      <div className="col-span-2 flex min-w-0 flex-col lg:col-span-1">
        <span className="font-semibold">{p.symbol}</span>
        <span className="truncate text-t-xs text-muted">{p.name}</span>
      </div>
      <div className={cell}>
        <span className={label}>{a.otc.unitPrice}</span>
        <span className="tnum text-t-sm">{usd(p.pricePerUnit, locale, p.precision)}</span>
      </div>
      <div className={cell}>
        <span className={label}>{a.otc.available}</span>
        <span data-listing-quantity="" className="tnum text-t-sm">
          {tonnes(p.quantity, locale)}
        </span>
      </div>
      <div className={cell}>
        <span className={label}>{a.otc.minQty}</span>
        <span className="tnum text-t-sm">{tonnes(p.minQuantity, locale)}</span>
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-gap lg:col-span-1 lg:justify-end">
        {p.armed ? (
          <button type="button" data-keep-for={p.id} onClick={p.onKeep} className={SECONDARY_BUTTON}>
            {a.otc.keep}
          </button>
        ) : null}
        <button
          type="button"
          data-cancel-listing={p.id}
          data-armed={p.armed ? "" : undefined}
          aria-disabled={p.busy || undefined}
          aria-busy={p.busy || undefined}
          aria-label={`${p.armed ? a.otc.cancelConfirm : a.otc.cancel} ${p.symbol}`}
          onClick={() => {
            if (!p.busy) p.onCancel(p.id);
          }}
          className={`inline-flex min-h-touch items-center rounded-chip border px-3 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus aria-disabled:opacity-50 lg:min-h-0 lg:px-2 lg:py-1 ${
            p.armed ? "border-danger bg-danger-soft text-danger" : "border-(--terminal-border) text-muted hover:border-danger/40 hover:text-danger"
          }`}
        >
          {p.armed ? a.otc.cancelConfirm : a.otc.cancel}
        </button>
      </div>
    </li>
  );
});

export type OtcListingsViewProps = {
  listings: readonly OtcListingView[];
  meta: Readonly<Record<string, PositionMeta>>;
  armedId: string | null;
  busyIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onKeep: () => void;
};

/**
 * 我的 OTC 挂牌(纯展示;SSR 测试直接渲染;调用方只在有挂牌时渲染它):标的、单价、可售数量、最小成交量、下架。
 * 下架是两步:第一次点 → 同一个按钮变成「确认下架」(危险色)+ 旁边一个「保留」;再点才发请求。Esc / 保留取消。
 */
export function OtcListingsView({ listings, meta, armedId, busyIds, onCancel, onKeep }: OtcListingsViewProps) {
  const a = useT("account");
  const { lang } = useLang();
  return (
    <section aria-labelledby="otc-title" data-otc-listings="" className={`flex flex-col ${PANEL}`}>
      <div className="flex flex-wrap items-center justify-between gap-gap border-b border-(--terminal-border) p-panel">
        <div className="flex flex-col">
          <h2 id="otc-title" className={PANEL_TITLE}>
            {a.otc.title}
          </h2>
          <p className="text-t-xs text-muted">{a.otc.lockNote}</p>
        </div>
        <Link href="/otc" prefetch={false} className="text-t-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus">
          {a.otc.market}
        </Link>
      </div>
      <div aria-hidden="true" className="t-otc-grid hidden border-b border-(--terminal-border) px-panel py-gap text-t-xs text-muted lg:grid">
        <span />
        <span className="text-end">{a.otc.unitPrice}</span>
        <span className="text-end">{a.otc.available}</span>
        <span className="text-end">{a.otc.minQty}</span>
        <span />
      </div>
      <ul aria-label={a.otc.title}>
        {listings.map((listing) => (
          <OtcListingRow
            key={listing.id}
            id={listing.id}
            symbol={listing.symbol}
            name={tName(listing.symbol, meta[listing.symbol]?.name ?? listing.symbol, lang)}
            pricePerUnit={listing.pricePerUnit}
            quantity={listing.quantity}
            minQuantity={listing.minQuantity}
            precision={meta[listing.symbol]?.pricePrecision ?? 2}
            armed={armedId === listing.id}
            busy={busyIds.has(listing.id)}
            onCancel={onCancel}
            onKeep={onKeep}
          />
        ))}
      </ul>
    </section>
  );
}

/** 各条挂牌「下架」按钮上的属性(data-cancel-listing = 挂牌 id),DOM 顺序即列表顺序 */
const CANCEL_BUTTONS = "[data-cancel-listing]";

/**
 * 一条挂牌下架(或因别的原因从列表里消失)之后焦点的着落:它后面那一条的 id,没有就前面那一条的,只有它一条就是 null。
 * 按 host 里「下架」按钮的 DOM 顺序取(与列表顺序一致);id 不在 host 里也是 null。
 */
export function neighborListingId(host: Pick<Element, "querySelectorAll"> | null, id: string): string | null {
  const ids = host ? Array.from(host.querySelectorAll(CANCEL_BUTTONS), (button) => button.getAttribute("data-cancel-listing")) : [];
  const index = ids.indexOf(id);
  if (index < 0) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * 挂牌行消失之后(P2-13,终审 UI-1):焦点没有着落(落在 body 上)时才动 —— 放到 neighborId 那一条的「下架」按钮上;
 * 没有这一条(列表空了,整块挂牌区随之卸载)就放到持仓区标题(#holdings-title,tabIndex -1,与 Holdings 的 focusHoldingsTitle 同一个着落)。
 * 焦点在别处(用户已经移开)时不动。root 传 document:挂牌区可能已经卸载,不能从它自己的节点里找。
 */
export function focusAfterListingGone(root: Pick<ParentNode, "querySelector" | "querySelectorAll">, neighborId: string | null, active: Element | null, body: Element | null): void {
  if (active && active !== body) return;
  const next = neighborId === null ? undefined : Array.from(root.querySelectorAll<HTMLElement>(CANCEL_BUTTONS)).find((button) => button.getAttribute("data-cancel-listing") === neighborId);
  (next ?? root.querySelector<HTMLElement>("#holdings-title"))?.focus();
}

/** 下一帧(React 已把消失的行移出 DOM)做 focusAfterListingGone */
const focusNextFrame = (neighborId: string | null) =>
  requestAnimationFrame(() => focusAfterListingGone(document, neighborId, document.activeElement, document.body));

/**
 * 我的 OTC 挂牌(容器):两步下架 → DELETE /api/otc/{id}。成功:toast、先把这一条从列表里拿掉(onCancelled)、再重取总览;
 * 持仓的锁定数量靠服务端撤牌后的 position 事件更新(P2-03;轮询 ≤ 5 s),这里不改账户 store。
 * 失败:401 → 账户 store 重新确认身份;其余 toast「下架没有成功」,并重取总览(挂牌可能已被买走或已下架)。
 * 武装的挂牌不在列表里了(被买走 / 在别处下架)就视同取消武装(派生,不写回 state)。
 * onCancel / onKeep 引用稳定(useCallback),各行的 memo 才命中:页头合计随行情重算时整页重渲染,挂牌行不跟着重跑。
 * 两个回调里要读「武装的是哪一条」:经 armedRef 读(与 armed 在同一处、同一时刻写),不进依赖;点击只可能来自列表里现有的行,
 * 所以 armedRef.current === id 与派生的 armedId === id 等价。
 * 焦点:按下「确认下架」时焦点在这一行的按钮上,行一消失焦点就掉到 body。成功时先记下它的邻居,拿掉这一行之后下一帧把焦点放到
 * 邻居的「下架」按钮上(没有邻居 → 持仓区标题);失败后重取总览若拿掉了这一行(挂牌已被买走),同样处理(focusAfterListingGone)。
 */
export function OtcListingsSection({
  listings,
  meta,
  onCancelled,
  onRefresh,
}: {
  listings: readonly OtcListingView[];
  meta: Readonly<Record<string, PositionMeta>>;
  onCancelled: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const a = useT("account");
  const push = useToast();
  const [armed, setArmed] = useState<string | null>(null);
  /** 与 armed 同步写(只在事件里):给引用稳定的回调读当前武装的是哪一条 */
  const armedRef = useRef<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const hostRef = useRef<HTMLDivElement>(null);
  const armedId = armed !== null && listings.some((listing) => listing.id === armed) ? armed : null;

  const handleKeep = useCallback(() => {
    const id = armedRef.current;
    if (id !== null) requestAnimationFrame(() => hostRef.current?.querySelector<HTMLElement>(`[data-cancel-listing="${CSS.escape(id)}"]`)?.focus());
    armedRef.current = null;
    setArmed(null);
  }, []);

  const handleCancel = useCallback(
    (id: string) => {
      if (armedRef.current !== id) {
        armedRef.current = id;
        setArmed(id);
        return;
      }
      armedRef.current = null;
      setArmed(null);
      setBusyIds((prev) => new Set(prev).add(id));
      /** 这一行消失之后焦点的着落;在它还在 DOM 里的时候记下 */
      let neighbor: string | null = null;
      api(otcListingUrl(id), { method: "DELETE" })
        .then(() => {
          neighbor = neighborListingId(hostRef.current, id);
          push("ok", a.otc.cancelled, { dedupeKey: `otc:${id}` });
          onCancelled(id);
          focusNextFrame(neighbor);
        })
        .catch((err: unknown) => {
          neighbor = neighborListingId(hostRef.current, id);
          // 服务端的英文原文不上界面(与终端 LoginGate 同一口径);挂牌多半已被买走或已下架,重取总览后列表自己会对上
          if (err instanceof ApiError && err.status === 401) void accountActions.refresh();
          push("err", a.otc.cancelFailed, { dedupeKey: `otc:${id}` });
        })
        .finally(() => {
          setBusyIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          // 重取之后这一行若不在了(失败:挂牌已被买走),焦点同样找着落;成功那条路上焦点已在邻居上,这里不再动
          void onRefresh().then(() => focusNextFrame(neighbor), () => {});
        });
    },
    [a, push, onCancelled, onRefresh],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || armedId === null) return;
    event.preventDefault();
    handleKeep();
  };

  return (
    <div ref={hostRef} onKeyDown={handleKeyDown}>
      <OtcListingsView listings={listings} meta={meta} armedId={armedId} busyIds={busyIds} onCancel={handleCancel} onKeep={handleKeep} />
    </div>
  );
}
