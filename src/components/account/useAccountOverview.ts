"use client";
// 资产页的总览数据(计划 §6.2.2 C6、§6.2.3 P2-10):GET /api/account/overview。
//   - 首屏:第一次取回时把持仓与余额落进账户 store(seedFromOverview;请求期间 store 被写过就不落),之后持仓与余额只跟 store;
//     所以只有这个用户的第一次取全量,之后的重取都用精简模式 ?parts=extras(只有 24 小时变化与挂牌,服务端不做成本回放;P2-13);
//   - 24 小时变化与本人 ACTIVE 的 OTC 挂牌只有这个接口给:每 OVERVIEW_REFRESH_MS(60 s)重取一次(usePolling:页面在后台时停,回前台立即取;
//     第一次不看可见性(runFirstWhileHidden):在后台标签页里打开资产页也立即取,首屏不会一直是骨架),
//     账户状态变了(成交、注销、挂牌 / 撤牌:accountSignature 变了)去抖 OVERVIEW_DEBOUNCE_MS 后再取一次;
//   - 401 → 账户 store 重新确认身份(会话过期时页面随之变成登录入口);其它失败:第一次就失败 → 页面出错可重试,之后 → 保留上一份、标记 stale;
//   - 过期的响应(换了用户、又发了一次)按票号丢弃。
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountOverviewExtras, AccountOverviewExtrasResponse, AccountOverviewResponse } from "@/shared";
import { FIRST_RUN_WHILE_HIDDEN, usePolling } from "@/hooks/usePolling";
import { ApiError, api } from "@/lib/http/client";
import { accountActions, useAccountStore } from "@/lib/market/account-store";
import { accountSignature, overviewGuard, seedFromOverview } from "@/lib/market/account-view";
import { getMarketRuntime } from "@/lib/market/MarketProvider";

export const OVERVIEW_URL = "/api/account/overview";
/** 精简模式:只有 24 小时变化与挂牌(服务端 src/lib/server/account-overview.ts) */
export const OVERVIEW_EXTRAS_URL = `${OVERVIEW_URL}?parts=extras`;
/** 24 小时变化与 OTC 挂牌的定时重取间隔 */
export const OVERVIEW_REFRESH_MS = 60_000;
/** 账户事件之后重取的去抖:一次成交常带来 order / fill / balance / position 几条事件,等它们都落了再取一次 */
export const OVERVIEW_DEBOUNCE_MS = 1_000;

/** 总览里只有这个接口给的两样(持仓与余额在账户 store) */
export type OverviewExtras = AccountOverviewExtras;

export type OverviewFetch = { full: true; overview: AccountOverviewResponse } | { full: false; overview: AccountOverviewExtrasResponse };

/**
 * 取一次总览:这个用户还没用总览落过 store(seeded false)→ 全量,否则 → 精简(只有 24 小时变化与挂牌)。
 * request 默认是 api();失败原样抛(ApiError 带状态码)。
 */
export async function fetchOverview(seeded: boolean, request: typeof api = api): Promise<OverviewFetch> {
  return seeded
    ? { full: false, overview: await request<AccountOverviewExtrasResponse>(OVERVIEW_EXTRAS_URL) }
    : { full: true, overview: await request<AccountOverviewResponse>(OVERVIEW_URL) };
}

export type AccountOverviewState = {
  /** 当前用户的总览;还没取到过为 null */
  data: OverviewExtras | null;
  /** 最近一次取失败了(有 data 时 = 显示的是上一份) */
  failed: boolean;
  /** 立即重取(重试按钮、撤牌之后);失败时 reject */
  reload: () => Promise<void>;
  /** 撤牌成功后先把这一条从列表里拿掉(不等重取) */
  dropListing: (id: string) => void;
};

type Loaded = { userId: string | null; data: OverviewExtras | null; failed: boolean };

/** meId:已登录用户的 id;null(未登录、身份未知)时什么都不取 */
export function useAccountOverview(meId: string | null): AccountOverviewState {
  const [loaded, setLoaded] = useState<Loaded>({ userId: null, data: null, failed: false });
  const ticket = useRef(0);
  /** 已经用总览落过 store 的用户:之后的重取只更新 24 小时变化与挂牌 */
  const seededFor = useRef<string | null>(null);
  /** 上一次成功取回时账户 store 的摘要(连同那是谁的):同一用户的摘要变了才因账户事件重取 */
  const loadedSignature = useRef<{ userId: string; signature: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!meId) return;
    const request = ++ticket.current;
    const guard = overviewGuard();
    try {
      // 这个用户已经落过 store:只取 24 小时变化与挂牌
      const fetched = await fetchOverview(seededFor.current === meId);
      if (request !== ticket.current) return;
      const { overview } = fetched;
      if (fetched.full && seededFor.current !== meId) {
        // 还没应用的推送先落地,版本号才准(期间有推送就说明 store 比这份 REST 新,不落)
        getMarketRuntime()?.batcher.flush();
        if (guard?.userId === meId) seedFromOverview(fetched.overview, guard);
        seededFor.current = meId;
      }
      const state = useAccountStore.getState();
      loadedSignature.current = { userId: meId, signature: accountSignature(state.balance, state.positions) };
      setLoaded({ userId: meId, data: { change24h: overview.change24h, otcListings: overview.otcListings }, failed: false });
    } catch (err) {
      if (request !== ticket.current) return;
      if (err instanceof ApiError && err.status === 401) void accountActions.refresh();
      setLoaded((prev) => ({ userId: meId, data: prev.userId === meId ? prev.data : null, failed: true }));
      throw err;
    }
  }, [meId]);

  // 立即取一次(页面在后台也取:首屏只有这一个来源),之后每 60 s;后台暂停、回前台立即取;换用户重启
  usePolling(load, OVERVIEW_REFRESH_MS, meId, FIRST_RUN_WHILE_HIDDEN);

  // 账户事件之后(摘要变了)去抖重取
  const signature = useAccountStore((s) => accountSignature(s.balance, s.positions));
  useEffect(() => {
    const last = loadedSignature.current;
    if (!meId || last === null || last.userId !== meId || signature === last.signature) return;
    const timer = setTimeout(() => {
      // 页面在后台时不追事件重取:回到前台时 usePolling 会立即取一次;几个后台标签页各自追事件会一起顶到每用户 30 次 / 分钟的限流
      if (document.hidden) return;
      void load().catch(() => {});
    }, OVERVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [meId, signature, load]);

  const dropListing = useCallback((id: string) => {
    setLoaded((prev) => (prev.data ? { ...prev, data: { ...prev.data, otcListings: prev.data.otcListings.filter((listing) => listing.id !== id) } } : prev));
  }, []);

  const current = loaded.userId === meId && meId !== null;
  return { data: current ? loaded.data : null, failed: current && loaded.failed, reload: load, dropListing };
}
