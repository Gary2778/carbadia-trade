// 持仓的分组与估值(计划 §6.2.3 P2-09;纯函数,零 React)。终端「持仓」页签用,资产页(P2-10)可直接复用:
//   - positionMetaOf:行情 store 的 instruments → 分组要用的静态元数据(不含价格),内容不变就返回同一个引用;
//   - groupPositions:按项目(projectId;没有就按标的)分组、组内按年份;整仓注销的行(quantity 0、retired > 0)单独收起;
//   - lockSourcesOf:锁定来源(服务端没给时为 null,界面只显示锁定总数);
//   - positionValue:按行情的最新价现算市值与未实现盈亏(事件里的 marketValue / unrealisedPnl 是生成事件那一刻冻结的)。
// 金额整数分、数量整数吨。
import type { Instrument, Position } from "@/shared";
import { unrealisedPnlAt } from "@/shared/unrealised-pnl";
import { compareCodeUnits } from "./instrument-filter";

/** 标的的静态元数据:分组头(项目编号 / 类型 / 标准 / 国家)、行(年份、价格精度)与注销对话框(名称、登记簿、标准)用 */
export type PositionMeta = Pick<Instrument, "name" | "projectId" | "projectType" | "standard" | "country" | "registry" | "vintage" | "pricePrecision">;

const META_KEYS = ["name", "projectId", "projectType", "standard", "country", "registry", "vintage", "pricePrecision"] as const satisfies readonly (keyof PositionMeta)[];

const pickMeta = (instrument: Instrument): PositionMeta => ({
  name: instrument.name,
  projectId: instrument.projectId,
  projectType: instrument.projectType,
  standard: instrument.standard,
  country: instrument.country,
  registry: instrument.registry,
  vintage: instrument.vintage,
  pricePrecision: instrument.pricePrecision,
});

function sameMeta(a: Readonly<Record<string, PositionMeta>>, b: Readonly<Record<string, PositionMeta>>): boolean {
  const symbols = Object.keys(a);
  if (symbols.length !== Object.keys(b).length) return false;
  for (const symbol of symbols) {
    const x = a[symbol];
    const y = b[symbol];
    if (!y) return false;
    for (const key of META_KEYS) if (x[key] !== y[key]) return false;
  }
  return true;
}

const EMPTY_META: Readonly<Record<string, PositionMeta>> = Object.freeze({});
let metaSource: Readonly<Record<string, Instrument>> | null = null;
let metaValue: Readonly<Record<string, PositionMeta>> = EMPTY_META;

/**
 * symbol → 静态元数据。可直接当 zustand 选择器用(useMarketStore((s) => positionMetaOf(s.instruments))):
 * 同一个 instruments 引用直接返回上次的结果;轮询模式每 2 s 整体替换 instruments、行情推送只改 lastPrice 时,
 * 内容没变就仍返回上一个对象 —— 订阅它的组件不重渲染(计划 §3.1:面板只订阅自己的选择器)。
 * 模块级只记一份(行情 store 是模块级单例,调用方只有它)。空的 instruments(store 的初始状态:服务端渲染与水合读的就是它)
 * 恒返回同一个空对象,也不占用那一份记忆 —— 初始状态与当前状态交替着读也不会互相顶掉。
 */
export function positionMetaOf(instruments: Readonly<Record<string, Instrument>>): Readonly<Record<string, PositionMeta>> {
  if (instruments === metaSource) return metaValue;
  const next: Record<string, PositionMeta> = {};
  let count = 0;
  for (const symbol in instruments) {
    next[symbol] = pickMeta(instruments[symbol]);
    count++;
  }
  if (count === 0) return EMPTY_META;
  metaSource = instruments;
  if (!sameMeta(metaValue, next)) metaValue = next;
  return metaValue;
}

export type PositionGroup = {
  /** 分组键(全表唯一):有项目编号的是 "project:<编号>",否则 "symbol:<代码>" */
  key: string;
  /** 项目编号;null = 这一组是单个标的(没有项目编号的标的、情景标的、元数据还没到的标的) */
  projectId: string | null;
  /** 组里第一行(年份最早)的标的代码:没有项目编号时当组名 */
  symbol: string;
  /** 取自组里第一行的元数据;元数据还没到时为 null(界面只显示组名,不猜) */
  projectType: string | null;
  standard: string | null;
  country: string | null;
  isScenario: boolean;
  /** 组内按年份升序(年份未知的排最后),同年按代码 */
  positions: Position[];
};

export type GroupedPositions = {
  /** 还有数量的持仓(quantity > 0),按组内最小的标的代码升序 */
  groups: PositionGroup[];
  /** 整仓注销的行(quantity 0、retired > 0),按代码升序 */
  retired: Position[];
  /** retired 各行已注销吨数之和 */
  retiredTonnes: number;
};

const vintageOf = (meta: Readonly<Record<string, PositionMeta>>, symbol: string): number => meta[symbol]?.vintage ?? Number.POSITIVE_INFINITY;

/**
 * 分组(计划 §6.2.3 P2-09):同一项目的不同年份是不同标的,收在一个组头下面、一年一行。
 *   - 分组键是 projectId;为 null(或元数据缺失)时该标的自成一组。情景标的不是项目碳信用,永远自成一组,不并进同编号的项目。
 *   - quantity 0 且 retired 0 的行不是持仓(服务端只在事件里发它,用来清行),这里丢掉。
 */
export function groupPositions(positions: readonly Position[], meta: Readonly<Record<string, PositionMeta>>): GroupedPositions {
  const byKey = new Map<string, PositionGroup>();
  const retired: Position[] = [];
  let retiredTonnes = 0;
  for (const position of positions) {
    if (position.quantity <= 0) {
      if (position.retired > 0) {
        retired.push(position);
        retiredTonnes += position.retired;
      }
      continue;
    }
    const m = meta[position.symbol];
    const projectId = !position.isScenario && m?.projectId ? m.projectId : null;
    const key = projectId ? `project:${projectId}` : `symbol:${position.symbol}`;
    const group = byKey.get(key);
    if (group) group.positions.push(position);
    else {
      byKey.set(key, {
        key,
        projectId,
        symbol: position.symbol,
        projectType: null,
        standard: null,
        country: null,
        isScenario: position.isScenario,
        positions: [position],
      });
    }
  }
  const groups = [...byKey.values()];
  for (const group of groups) {
    group.positions.sort((a, b) => vintageOf(meta, a.symbol) - vintageOf(meta, b.symbol) || compareCodeUnits(a.symbol, b.symbol));
    const first = meta[group.positions[0].symbol];
    group.symbol = group.positions[0].symbol;
    group.projectType = first?.projectType || null;
    group.standard = first?.standard || null;
    group.country = first?.country || null;
  }
  const minSymbol = (group: PositionGroup): string => group.positions.reduce((min, p) => (compareCodeUnits(p.symbol, min) < 0 ? p.symbol : min), group.positions[0].symbol);
  groups.sort((a, b) => compareCodeUnits(minSymbol(a), minSymbol(b)));
  retired.sort((a, b) => compareCodeUnits(a.symbol, b.symbol));
  return { groups, retired, retiredTonnes };
}

/**
 * 锁定来源(挂单 / 场外挂牌各锁了多少)。null = 服务端没给:lockedBy 是 Phase 2 才有的字段,Phase 2 的浏览器对着回滚到
 * Phase 1 的服务端时持仓里没有它 —— 界面只显示锁定总数(locked),不拆来源,也不能因此崩掉。
 */
export function lockSourcesOf(position: { lockedBy?: Position["lockedBy"] | null }): Position["lockedBy"] | null {
  const sources = position.lockedBy;
  return sources && Number.isFinite(sources.orders) && Number.isFinite(sources.otc) ? sources : null;
}

/** 行情 store 里某个标的的最新价(定义在 ./last-price.ts,下单面板也用;这里原样再导出,既有调用方不用改) */
export { lastPriceOf } from "./last-price";

export type PositionValue = {
  /** 估值用的价格:行情的最新价,行情里没有时退回持仓事件自带的那个;null = 从未成交 */
  lastPrice: number | null;
  /** lastPrice × quantity;没有价格 → null(界面显示「—」,不把缺的价格当 0) */
  marketValue: number | null;
  /** 成本不完整(costBasisStatus ≠ complete)→ null,永不把缺失的成本当零 */
  averagePurchasePrice: number | null;
  unrealisedPnl: number | null;
};

/**
 * 按最新价现算一行持仓的市值与未实现盈亏(计划 §6.2.3 P2-09:不用事件里冻结的 marketValue)。终端「持仓」页签与资产页(P2-10)逐行都用它。
 * 盈亏与账户合计是同一个实现:src/shared/unrealised-pnl.ts 的 unrealisedPnlAt(computeAccountTotals 也调它)—— 成本取服务端映射时算好、取过整的那一份
 *(position.lastPrice × quantity − position.unrealisedPnl),与服务端逐分一致;服务端那一刻没有价格时退到 均价 × 数量。
 * 所以同一份持仓、同一组价格上,各行的 marketValue / unrealisedPnl 相加就是 computeAccountTotals 的 holdingsValue / unrealisedPnl
 *(position-groups.test.ts 钉住)。行上的 lastPrice / marketValue / unrealisedPnl 不改写,实时价只经 livePrice 传入。
 */
export function positionValue(
  position: Pick<Position, "quantity" | "lastPrice" | "averagePurchasePrice" | "unrealisedPnl" | "costBasisStatus">,
  livePrice: number | null | undefined,
): PositionValue {
  const lastPrice = livePrice ?? position.lastPrice;
  const value = lastPrice == null ? null : lastPrice * position.quantity;
  const marketValue = value != null && Number.isSafeInteger(value) ? value : null;
  if (position.costBasisStatus !== "complete") return { lastPrice, marketValue, averagePurchasePrice: null, unrealisedPnl: null };
  const unrealisedPnl = lastPrice != null && marketValue != null ? unrealisedPnlAt(position, lastPrice) : null;
  return { lastPrice, marketValue, averagePurchasePrice: position.averagePurchasePrice, unrealisedPnl };
}

/** 「注销」请求:点了哪个持仓的「注销」,对话框此刻开没开(关掉之后留着,对话框不卸载、里面没做完的事还在) */
export type RetireRequest = { assetId: string; open: boolean };

/**
 * 纯函数:渲染期对注销请求的调整(PositionsTab 与资产页的持仓表按 React「随输入调整 state」的写法调用,同 OpenOrdersTab 的 reconcileArmed)。
 * 请求对着的持仓不在 store 里了(卖光且没注销过:数量 0、已注销 0 的行会被移除)→ 请求作废:返回 request null、dropped true,
 * wasOpen 说明作废时对话框是不是开着(开着的话它随之卸载,焦点要有个着落)。否则原样、dropped false。
 * 清的是 state 本身而不只是派生值:同一个标的之后再买回来,对话框不会自己弹出来。
 */
export function reconcileRetireRequest(request: RetireRequest | null, positions: readonly Pick<Position, "assetId">[]): { request: RetireRequest | null; dropped: boolean; wasOpen: boolean } {
  if (request !== null && !positions.some((p) => p.assetId === request.assetId)) return { request: null, dropped: true, wasOpen: request.open };
  return { request, dropped: false, wasOpen: false };
}
