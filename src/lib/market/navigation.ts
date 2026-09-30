// 终端的 URL 与导航(计划 §3.2「换标的不走 RSC」、§3.6、R17):
//   - 换标的 = window.history.replaceState 到 /trade/<symbol>(保留 query 与 hash)+ 手写 document.title + writePrefs({ lastSymbol });
//     Next 16 的原生 history 同步让 usePathname() 更新,TerminalShell 经 symbolFromPath 派生新 symbol,不发 RSC 请求;
//   - 筛选状态经 writeFiltersToUrl 用 replaceState 镜像到 query;readFiltersFromUrl 是纯函数,服务端 page.tsx 传 searchParams,
//     客户端不传参时读 window.location.search —— 两边同一解析,SSR 与水合首帧一致;
//   - 标题:generateMetadata 给 `${symbol} · Terminal`,经根布局模板 "%s · Carbadia Trade" 渲染;switchSymbol 写的是模板化后的
//     terminalTitle(symbol),否则换标的后标题短一截(navigation.test.ts 断言二者一致)。
// 本模块不带 "use client":服务端 page / layout 也从这里取纯函数;碰 window 的函数在服务端调用时是空操作。
import type { Side } from "@/shared";
import type { InstrumentFilters, InstrumentSort } from "./instrument-filter";
import { writePrefs } from "./prefs";

/** /trade/<SYMBOL>:大写字母数字段以单个连字符相连(VCS-FOR-2021、CEA-SCEN-2026);可带一个结尾斜杠 */
const TERMINAL_PATH = /^\/trade\/([A-Z0-9]+(?:-[A-Z0-9]+)*)\/?$/;

/** 从 pathname 取标的代码;不是 /trade/<SYMBOL> 形状(含小写、多一段、空)一律 null */
export function symbolFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const path = pathname.split(/[?#]/, 1)[0];
  const match = TERMINAL_PATH.exec(path);
  return match ? match[1] : null;
}

/** /trade/<symbol>[?query];query 可带或不带前导 "?",空串 / "?" / 空 URLSearchParams 不输出 "?" */
export function terminalHref(symbol: string, query?: string | URLSearchParams | null): string {
  const base = `/trade/${encodeURIComponent(symbol)}`;
  const q = query == null ? "" : typeof query === "string" ? query.replace(/^\?/, "") : query.toString();
  return q ? `${base}?${q}` : base;
}

/** generateMetadata 的标题(根布局模板套上 " · Carbadia Trade" 之前) */
export function terminalMetaTitle(symbol: string): string {
  return `${symbol} · Terminal`;
}

/** document.title 的最终值 = terminalMetaTitle 经根布局模板 "%s · Carbadia Trade" 之后的字符串 */
export function terminalTitle(symbol: string): string {
  return `${terminalMetaTitle(symbol)} · Carbadia Trade`;
}

/** 换标的:replaceState(不进历史、不走 RSC)+ 模板化标题 + 记住 lastSymbol。服务端调用为空操作 */
export function switchSymbol(symbol: string): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const target = terminalHref(symbol);
  if (pathname !== target) window.history.replaceState(null, "", `${terminalHref(symbol, search)}${hash}`);
  document.title = terminalTitle(symbol);
  writePrefs({ lastSymbol: symbol });
}

// ---- 查询参数 ----

/** Next page 的 searchParams(普通对象,重复键为数组)或 URLSearchParams */
export type QueryInput = URLSearchParams | Record<string, string | string[] | undefined>;

/** 筛选键在 URL 里的名字;顺序即序列化顺序(URL 稳定,不随用户点选顺序变化)。价格是整数分 */
const FILTER_PARAMS = {
  q: "q",
  registry: "registry",
  projectType: "projectType",
  vintage: "vintage",
  minPrice: "minPrice",
  maxPrice: "maxPrice",
  watchlistOnly: "watchlist",
  sort: "sort",
} as const satisfies Record<keyof InstrumentFilters, string>;

const SORTS: readonly InstrumentSort[] = ["symbol", "change", "volume", "price"];
const UINT = /^\d+$/;
const YEAR = /^\d{4}$/;

function paramOf(params: QueryInput, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};
const uint = (value: string | undefined): number | undefined => {
  const trimmed = value?.trim();
  return trimmed && UINT.test(trimmed) ? Number(trimmed) : undefined;
};

const currentSearch = (): string => (typeof window === "undefined" ? "" : window.location.search);

/**
 * 读筛选条件:空串、非法数字(负数、小数、指数写法)、未知排序一律丢弃,不猜。
 * 不传参数时读 window.location.search(服务端为空)。
 */
export function readFiltersFromUrl(params?: QueryInput): InstrumentFilters {
  const source = params ?? new URLSearchParams(currentSearch());
  const out: InstrumentFilters = {};
  const q = nonEmpty(paramOf(source, FILTER_PARAMS.q));
  if (q !== undefined) out.q = q;
  const registry = nonEmpty(paramOf(source, FILTER_PARAMS.registry));
  if (registry !== undefined) out.registry = registry;
  const projectType = nonEmpty(paramOf(source, FILTER_PARAMS.projectType));
  if (projectType !== undefined) out.projectType = projectType;
  const vintage = paramOf(source, FILTER_PARAMS.vintage)?.trim();
  if (vintage && YEAR.test(vintage)) out.vintage = Number(vintage);
  const minPrice = uint(paramOf(source, FILTER_PARAMS.minPrice));
  if (minPrice !== undefined) out.minPrice = minPrice;
  const maxPrice = uint(paramOf(source, FILTER_PARAMS.maxPrice));
  if (maxPrice !== undefined) out.maxPrice = maxPrice;
  if (paramOf(source, FILTER_PARAMS.watchlistOnly) === "1") out.watchlistOnly = true;
  const sort = paramOf(source, FILTER_PARAMS.sort);
  if (sort && (SORTS as readonly string[]).includes(sort)) out.sort = sort as InstrumentSort;
  return out;
}

/** 纯函数:把筛选写进一段 search(先删全部筛选键,再按固定顺序写非空值;其它参数原样保留)。返回 "" 或以 "?" 开头 */
export function filtersToSearch(search: string, filters: InstrumentFilters): string {
  const params = new URLSearchParams(search);
  for (const key of Object.values(FILTER_PARAMS)) params.delete(key);
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };
  set(FILTER_PARAMS.q, filters.q?.trim());
  set(FILTER_PARAMS.registry, filters.registry?.trim());
  set(FILTER_PARAMS.projectType, filters.projectType?.trim());
  set(FILTER_PARAMS.vintage, filters.vintage);
  set(FILTER_PARAMS.minPrice, filters.minPrice);
  set(FILTER_PARAMS.maxPrice, filters.maxPrice);
  if (filters.watchlistOnly) params.set(FILTER_PARAMS.watchlistOnly, "1");
  set(FILTER_PARAMS.sort, filters.sort);
  const out = params.toString();
  return out ? `?${out}` : "";
}

/** 把筛选镜像到当前 URL:只用 replaceState(不进历史、不走 RSC);与当前 search 相同则不写。服务端为空操作 */
export function writeFiltersToUrl(filters: InstrumentFilters): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const next = filtersToSearch(search, filters);
  if (next === search) return;
  window.history.replaceState(null, "", `${pathname}${next}${hash}`);
}

/** ?side=BUY|SELL(大小写不敏感;/market 的 Advanced 入口与旧 tab=trade 契约沿用这个键)→ 下单面板的初始方向 */
export function readSideFromUrl(params: QueryInput): Side | undefined {
  const side = paramOf(params, "side")?.trim().toUpperCase();
  return side === "BUY" || side === "SELL" ? side : undefined;
}
