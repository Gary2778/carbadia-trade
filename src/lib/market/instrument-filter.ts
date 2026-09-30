// 标的列表的筛选与排序(计划 §3.6 useInstrumentList 内部调用、§3.1 InstrumentFilters 组件的筛选模型)。
// 纯函数、零 React;价格一律整数分。filterInstruments 由 P1-13 建立;facets / siblingsByProject / 价格输入换算由 P1-17 补齐。
import type { Instrument, Ticker } from "@/shared";

export type InstrumentSort = "symbol" | "change" | "volume" | "price";

/** 筛选条件:全部可选;q 大小写不敏感地匹配 symbol / name / registry / projectType;minPrice / maxPrice 为分 */
export type InstrumentFilters = {
  q?: string;
  registry?: string;
  projectType?: string;
  vintage?: number;
  minPrice?: number;
  maxPrice?: number;
  watchlistOnly?: boolean;
  sort?: InstrumentSort;
};

/** 列表行:ticker 在 store 尚无该键时为 undefined(组件用 instrument.lastPrice 兜底) */
export type InstrumentListRow = { instrument: Instrument; ticker: Ticker | undefined; starred: boolean };

const isFinitePrice = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** 行的现价:有 live ticker 就以它为准(哪怕是 null),没有 ticker 才用 SSR 注入的 instrument.lastPrice */
const priceOf = (row: InstrumentListRow): number | null => (row.ticker ? row.ticker.lastPrice : row.instrument.lastPrice);

/**
 * 与运行时默认 locale 无关的字符串比较(UTF-16 码元序)。凡是会进 SSR 标记的排序都用它:不带 locale 的 localeCompare
 * 跟随运行时默认 locale —— 服务端 Node(en-US)把汉字排在拉丁字母之后,zh-CN 浏览器按拼音排在前面,
 * 同一份数据两边出不同顺序,水合时报文本不一致。码元序在任何运行时都一样。
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 搜索是否命中:q trim 后大小写不敏感,是 symbol、种子原值(name / registry / projectType)或调用方给的
 * 显示标签(界面上翻译后的名称、注册机构、项目类型)任一的子串即命中;空白 q 恒为真。
 * 种子原值是中文,英文界面显示的是翻译 —— 只比原值时,英文界面搜 "forest" 找不到行里写着 Forest 的标的,所以 labels 由界面给
 * (终端标的面板给两种界面语言的译名,与当前语言无关,见 InstrumentPanel 的 searchLabels)。
 */
export function matchesQuery(instrument: Instrument, q: string | undefined, labels: readonly string[] = []): boolean {
  const needle = q?.trim().toLowerCase() ?? "";
  if (!needle) return true;
  const has = (s: string) => s.toLowerCase().includes(needle);
  return has(instrument.symbol) || has(instrument.name) || has(instrument.registry) || has(instrument.projectType) || labels.some(has);
}

/**
 * 按搜索词过滤已筛好的行(InstrumentPanel 在 useInstrumentList 的结果上带显示标签再过一道);保持入参顺序。
 * 空白 q 原样返回同一个数组引用,下游的记忆不会因为多了这一层而失效。
 */
export function filterByQuery<T extends { instrument: Instrument }>(rows: T[], q: string | undefined, labelsOf: (instrument: Instrument) => readonly string[]): T[] {
  if (!q?.trim()) return rows;
  return rows.filter((row) => matchesQuery(row.instrument, q, labelsOf(row.instrument)));
}

/** 空值排最后;非空按 desc(涨幅、量、价都是"大的在前"更符合看盘习惯) */
function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * 按 f 过滤并排序;不改入参,永远返回新数组。
 * - q:trim 后为空不过滤;否则 symbol / name / registry / projectType 的种子原值任一 includes(大小写不敏感,见 matchesQuery;
 *   翻译后的显示标签这里拿不到,终端的标的面板把 q 摘出来,改用 filterByQuery 带上两种语言的显示标签再过滤)
 * - registry / projectType:非空字符串时精确相等;vintage:有限数字时精确相等
 * - minPrice / maxPrice:以分比较现价(live ticker 优先);现价为 null 的行在设了任一价格区间时被排除
 * - watchlistOnly:只留 starred
 * - sort:symbol 按码元序升序(不随运行时 locale 变);change / volume / price 降序且 null 末尾;未指定时保持入参顺序
 */
export function filterInstruments(list: InstrumentListRow[], f: InstrumentFilters): InstrumentListRow[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  const registry = f.registry?.trim() || undefined;
  const projectType = f.projectType?.trim() || undefined;
  const vintage = typeof f.vintage === "number" && Number.isFinite(f.vintage) ? f.vintage : undefined;
  const minPrice = isFinitePrice(f.minPrice) ? f.minPrice : undefined;
  const maxPrice = isFinitePrice(f.maxPrice) ? f.maxPrice : undefined;

  const out = list.filter((row) => {
    const ins = row.instrument;
    if (f.watchlistOnly && !row.starred) return false;
    if (registry !== undefined && ins.registry !== registry) return false;
    if (projectType !== undefined && ins.projectType !== projectType) return false;
    if (vintage !== undefined && ins.vintage !== vintage) return false;
    if (minPrice !== undefined || maxPrice !== undefined) {
      const price = priceOf(row);
      if (price === null) return false;
      if (minPrice !== undefined && price < minPrice) return false;
      if (maxPrice !== undefined && price > maxPrice) return false;
    }
    if (q && !matchesQuery(ins, q)) return false;
    return true;
  });

  switch (f.sort) {
    case "symbol":
      out.sort((a, b) => compareCodeUnits(a.instrument.symbol, b.instrument.symbol));
      break;
    case "change":
      out.sort((a, b) => compareNullableDesc(a.ticker?.change24h ?? null, b.ticker?.change24h ?? null));
      break;
    case "volume":
      out.sort((a, b) => (b.ticker?.volume24h ?? 0) - (a.ticker?.volume24h ?? 0));
      break;
    case "price":
      out.sort((a, b) => compareNullableDesc(priceOf(a), priceOf(b)));
      break;
    default:
      break;
  }
  return out;
}

/** 是否设了任何筛选 / 排序(「清除筛选」按钮与空态入口据此显示);空白 q、空串、NaN 与未设同义 */
export function hasActiveFilters(f: InstrumentFilters): boolean {
  return Boolean(
    f.q?.trim() ||
      f.registry?.trim() ||
      f.projectType?.trim() ||
      (typeof f.vintage === "number" && Number.isFinite(f.vintage)) ||
      isFinitePrice(f.minPrice) ||
      isFinitePrice(f.maxPrice) ||
      f.watchlistOnly ||
      f.sort,
  );
}

/**
 * 改一个维度,返回新对象(不改入参);值为 undefined、空串、false、NaN 时删掉该键 —— 筛选对象里只留真正生效的键,
 * useInstrumentList 的记忆键与 URL(filtersToSearch)都因此稳定。q 不 trim:输入框要能打出空格,过滤时再 trim。
 */
export function setFilter<K extends keyof InstrumentFilters>(f: InstrumentFilters, key: K, value: InstrumentFilters[K]): InstrumentFilters {
  const next: InstrumentFilters = { ...f };
  const empty = value === undefined || value === "" || value === false || (typeof value === "number" && Number.isNaN(value));
  if (empty) delete next[key];
  else next[key] = value;
  return next;
}

/** 筛选下拉的可选值:只从真实标的元数据里收集,空串不收(不给「未提供」造一个可选项) */
export type InstrumentFacets = { registries: string[]; projectTypes: string[]; vintages: number[] };

/**
 * 从标的列表收集注册机构 / 项目类型 / 年份三组可选值:去重、去空;字符串按码元序升序(compareCodeUnits,
 * 不随运行时 locale 变 —— URL 带高级筛选时这些选项进 SSR 标记),年份升序。界面按显示文字的排序在 sortOptionsByLabel。
 * 入参只要求 { instrument },InstrumentListRow 与 SSR 注入的 InstrumentListItem 都能直接传。
 */
export function facets(list: readonly { instrument: Instrument }[]): InstrumentFacets {
  const registries = new Set<string>();
  const projectTypes = new Set<string>();
  const vintages = new Set<number>();
  for (const { instrument } of list) {
    if (instrument.registry.trim()) registries.add(instrument.registry);
    if (instrument.projectType.trim()) projectTypes.add(instrument.projectType);
    if (Number.isFinite(instrument.vintage)) vintages.add(instrument.vintage);
  }
  return {
    registries: [...registries].sort(compareCodeUnits),
    projectTypes: [...projectTypes].sort(compareCodeUnits),
    vintages: [...vintages].sort((a, b) => a - b),
  };
}

/**
 * 下拉选项按显示文字排序,collator 由调用方按界面语言给(InstrumentFilters:new Intl.Collator(当前语言));
 * 显示文字比不出先后时按原值的码元序,结果完全确定。不改入参。
 * 水合安全:SSR 与水合首帧的界面语言都是 DEFAULT_LANG(LangProvider 挂载后才读偏好),两边用同一语言的 collator 排同一组显示文字。
 */
export function sortOptionsByLabel<T extends { value: string; label: string }>(options: readonly T[], collator: Intl.Collator): T[] {
  return [...options].sort((a, b) => collator.compare(a.label, b.label) || compareCodeUnits(a.value, b.value));
}

/**
 * 同一项目(projectId 相同)的其它 vintage,供头部 VintageSelector 列年份 chip(计划 §3.1「同项目其它 vintage」)。
 * - projectId 为 null / 空串 → [](未知项目不猜归组);
 * - 情景标的一律排除(它们不是项目、也不加 vintage,计划 §9.1 第 15 条);
 * - excludeSymbol:排除当前标的自身;
 * - 按 vintage 升序,同年按 symbol 的码元序(与 facets 同一理由:这组 chip 进 SSR 标记,顺序不能随运行时 locale 变)。
 */
export function siblingsByProject(all: readonly Instrument[], projectId: string | null, excludeSymbol?: string): Instrument[] {
  if (!projectId) return [];
  return all
    .filter((ins) => ins.projectId === projectId && !ins.isScenario && ins.symbol !== excludeSymbol)
    .sort((a, b) => a.vintage - b.vintage || compareCodeUnits(a.symbol, b.symbol));
}

// ---- 价格区间输入:界面按美元输入(最多两位小数),筛选与 URL 一律整数分 ----

const PRICE_INPUT = /^(\d*)(?:\.(\d{0,2}))?$/;

/** "12" / "12.5" / "12.50" / ".5" / "12." 的美元输入 → 整数分;空串、单独的点、负数、三位以上小数、非数字 → undefined(不猜) */
export function priceInputToCents(text: string): number | undefined {
  const m = PRICE_INPUT.exec(text.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  const cents = Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** 整数分 → 输入框里的美元串(固定两位小数,不加千分位,便于再编辑);undefined → "" */
export function centsToPriceInput(cents: number | undefined): string {
  if (cents === undefined || !Number.isFinite(cents)) return "";
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/**
 * 价格输入框的外部同步(清除筛选、URL 改了值):框里的原文若仍表示新值就原样保留(正在输入的「12.」「12.5」不被改写),
 * 否则换成新值的标准写法。「解析不了的原文」(如「12.5x」)永远不算表示任何值 —— 哪怕新值是 undefined 也清掉,
 * 否则点「清除筛选」后框里还留着红框的无效字。只在外部值变化时调用,打字过程不经过这里。
 */
export function syncPriceInput(text: string, cents: number | undefined): string {
  const parsed = priceInputToCents(text);
  const stale = parsed !== cents || (parsed === undefined && text.trim() !== "");
  return stale ? centsToPriceInput(cents) : text;
}
