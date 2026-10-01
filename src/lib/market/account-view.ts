// 资产页 /trade/account 的纯函数(计划 §6.2.3 P2-10;零 React,node 环境可测)。
//   - accountPhase:页面处在哪一态(加载中 / 未登录 / 身份未确认 / 出错 / 就绪);
//   - heldPrices / liveTotals:持有标的的最新价(与终端持仓页签同一个取价规则 lastPriceOf)与按它重算的账户合计(computeAccountTotals);
//   - matchesHoldingQuery:持仓搜索;
//   - allocationOf:持仓分布(按项目类型 / 地域 / 类别),按市值算占比,情景标的除外;
//   - accountSignature:会影响 24 小时变化与 OTC 挂牌的账户状态摘要(变了就去抖重取总览);
//   - overviewGuard / seedFromOverview:首屏的 GET /api/account/overview 把持仓与余额落进账户 store(与 pollAccount 同一套「请求期间 store
//     被写过就作废」的办法),之后持仓与余额只跟 store(账户事件 / 轮询)。
// 金额整数分、数量整数吨。
import type { AccountOverview, AccountTotals, Balance, Position, ServerEvent } from "@/shared";
import { computeAccountTotals } from "@/shared/account-totals";
import { readListsVersion } from "./account-bridge";
import { applyAccountEvents, retainPositions, useAccountStore, type AccountStatus } from "./account-store";
import { lastPriceOf } from "./position-groups";

export type AccountPhase = "loading" | "anon" | "unverified" | "error" | "ready";

/**
 * 页面状态:身份还没确认(idle / loading)→ 加载中;确认的未登录 → 登录入口;/api/auth/me 瞬时失败落下的「未确认 anon」→ 出错可重试
 *(不把一次网络抖动说成「你没登录」);已登录 → 总览第一次回来之前是加载中,第一次就失败是出错,之后一直是就绪(刷新失败只提示,不撤掉数据)。
 */
export function accountPhase(status: AccountStatus, unverified: boolean, overview: { loaded: boolean; failed: boolean }): AccountPhase {
  if (status === "anon") return unverified ? "unverified" : "anon";
  if (status !== "ready") return "loading";
  if (overview.loaded) return "ready";
  return overview.failed ? "error" : "loading";
}

/** 行情 store 里本页用到的两块:推送的 ticker 与标的列表(lastPriceOf 的输入) */
export type MarketPrices = Parameters<typeof lastPriceOf>[0];

const NO_BALANCE: Balance = { cashBalance: 0, lockedCash: 0 };

/**
 * 持有标的的最新价(symbol → 分),取价规则与终端「持仓」页签的每一行相同:lastPriceOf(推送的 ticker → 标的列表);
 * 行情里都没有的为 null(调用方退回持仓行自带的 lastPrice)。资产页用它做浅比较订阅:只有持有的标的价格变了才重渲染。
 */
export function heldPrices(market: MarketPrices, positions: readonly Pick<Position, "symbol">[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const position of positions) out[position.symbol] = lastPriceOf(market, position.symbol);
  return out;
}

/**
 * 按行情的最新价重算账户合计(计划 §6.2.2 C6:客户端用 store 里的持仓与行情的最新价)。prices 是 heldPrices 的结果,
 * 没有价的退回持仓行自带的 lastPrice —— 与各行 positionValue(position, prices[symbol]) 同一组价格,所以页头的市值 / 盈亏与各行相加逐分相等。
 * 持仓行原样传入(不改写行上的 lastPrice / marketValue / unrealisedPnl)。
 */
export function liveTotals(balance: Balance | null, positions: readonly Position[], prices: Readonly<Record<string, number | null | undefined>>): AccountTotals {
  return computeAccountTotals(balance ?? NO_BALANCE, positions, (position) => prices[position.symbol] ?? position.lastPrice);
}

/** 持仓搜索:代码、项目编号、名称(当前语言的与原文)里含查询串即中,大小写不敏感;空查询全中 */
export function matchesHoldingQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field != null && field.toLowerCase().includes(q));
}

export type AllocationSlice = {
  /** 分组名(调用方给的,已按界面语言本地化;同名即同组) */
  label: string;
  /** 市值合计,整数分 */
  value: number;
  /** 持有吨数合计 */
  tonnes: number;
  /** value / 全部有价持仓的市值,0..1 */
  share: number;
};

export type Allocation = {
  /** 按市值降序(同值按名称) */
  slices: AllocationSlice[];
  /** 参与占比的市值合计(分) */
  total: number;
  /** 持有、不是情景标的、却没有价格的持仓数:不进占比(不把缺的价格当 0),界面说明一句 */
  unpriced: number;
};

/**
 * 持仓分布(计划 §6.2.3 P2-10):只看持有的(quantity > 0)、不是情景标的的持仓;按 groupOf 给的名字分组,
 * 占比按市值(priceOf × 数量)。没有价格的持仓不进占比,只计数。没有可算的持仓时 slices 为空。
 */
export function allocationOf(positions: readonly Position[], groupOf: (position: Position) => string, priceOf: (position: Position) => number | null): Allocation {
  const byLabel = new Map<string, { value: number; tonnes: number }>();
  let total = 0;
  let unpriced = 0;
  for (const position of positions) {
    if (position.quantity <= 0 || position.isScenario) continue;
    const price = priceOf(position);
    if (price == null || !Number.isFinite(price)) {
      unpriced++;
      continue;
    }
    const value = price * position.quantity;
    const label = groupOf(position);
    const slot = byLabel.get(label) ?? { value: 0, tonnes: 0 };
    slot.value += value;
    slot.tonnes += position.quantity;
    byLabel.set(label, slot);
    total += value;
  }
  const slices = [...byLabel].map(([label, slot]) => ({ label, value: slot.value, tonnes: slot.tonnes, share: total > 0 ? slot.value / total : 0 }));
  slices.sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { slices, total, unpriced };
}

/**
 * 账户状态摘要:余额两项 + 每个持仓的数量 / 锁定 / 场外锁定 / 已注销(按 assetId 排序)。这些变了,24 小时变化与 OTC 挂牌就可能变了
 *(成交、注销、挂牌 / 撤牌、别人买走了挂牌);价格不在里面(24 小时变化随价格的漂移靠 60 s 一次的定时重取)。
 * 轮询模式每 5 s 重灌一次同样的快照,store 里的引用会换,但摘要不变 —— 不会因此每 5 s 重取一次总览。
 */
export function accountSignature(balance: Balance | null, positions: ReadonlyMap<string, Position>): string {
  const rows = [...positions.values()]
    .map((p) => `${p.assetId}:${p.quantity}:${p.locked}:${p.lockedBy?.otc ?? ""}:${p.retired}`)
    .sort();
  return `${balance ? `${balance.cashBalance}/${balance.lockedCash}` : "-"}|${rows.join(",")}`;
}

/** 发请求那一刻的账户 store:身份、挂单 / 持仓的版本号、余额引用。响应回来时据此判断期间 store 有没有被写过 */
export type OverviewGuard = { userId: string; version: number; balance: Balance | null };

/** 已登录才有;未登录 / 身份未知时为 null(这时不落 store) */
export function overviewGuard(): OverviewGuard | null {
  const state = useAccountStore.getState();
  if (state.status !== "ready" || !state.me) return null;
  return { userId: state.me.id, version: readListsVersion(), balance: state.balance };
}

/**
 * 把总览里的持仓与余额落进账户 store(资产页首屏,计划 §6.2.3 P2-10「首屏取 overview,之后持仓与余额跟 store」)。
 * 与 pollAccount / loadAccountLists 同一套规则:身份变了、或请求期间挂单 / 持仓被写过(账户推送、订阅快照、轮询都比这份 REST 新)→ 整份不落,
 * 返回 false;余额另看,期间被写过就不用这份的。落的时候先按总览里的 assetId 收口(卖光的行移除),再逐行 upsert —— 与 WS 订阅快照同形。
 * 调用方在比较前先 flush batcher(还没应用的推送先落地,版本号才准)。
 */
export function seedFromOverview(overview: Pick<AccountOverview, "balance" | "positions">, guard: OverviewGuard): boolean {
  const now = useAccountStore.getState();
  if (now.status !== "ready" || now.me?.id !== guard.userId || readListsVersion() !== guard.version) return false;
  retainPositions(new Set(overview.positions.map((position) => position.assetId)));
  const events: ServerEvent[] = [];
  if (now.balance === guard.balance) events.push({ t: "balance", topic: "account", seq: 0, balance: overview.balance });
  for (const position of overview.positions) events.push({ t: "position", topic: "account", seq: 0, position });
  applyAccountEvents(events);
  return true;
}
