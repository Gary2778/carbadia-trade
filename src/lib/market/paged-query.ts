"use client";
// 游标分页的小 store(计划 §3.6、P1-21):OrderHistoryTab / FillsTab 走 /api/account/orders?status=history、/api/account/fills。
//
//   - loadMore():拉下一页(第一次即 cursor = null 的第一页),按 nextCursor 往后翻;在途时复用同一个 Promise(不对同一游标发两次),
//     最后一页(nextCursor = null)之后是空操作;失败不抛,落在 status = "error" / error,再调 loadMore 用同一游标重试;
//   - reset():清空并作废在途请求 —— 每次 reset 换一张「票」(代号),请求带着发出时的票,回来时票不对就整条丢弃(过期响应);
//   - prepend(items):新行插到最前(已有的键就地替换);给了 compare 时合并后按它重排;
//   - refresh():从第一页往下读,直到读到的页与已加载的行接上(见下),再合并到顶上,不闪 loading;
//     离开期间新增的行多于一页时,只读第一页会在新第一页与旧的头之间留一个洞,永远补不上 —— 所以要一直读到接缝;
//     读满 maxRefreshPages 页仍接不上,就以读到的这几页整体替换列表(游标跟着换,后面的照常翻页);读到底(nextCursor = null)同样整体替换;
//   - markStale(items):这些行在列表中间换了位置 / 新进了列表、内容未知(一张很早下的委托刚成交完或被撤,按它自己的 createdAt
//     进历史,可能在第一页之后):下一次 refresh 至少读到覆盖它们的位置;排在已加载末行之后的不管(loadMore 读到的就是终态);
//     按 getKey 记(同一行重复标记只算一条),超过 MAX_STALE_ROWS 条就不再逐条记,改为「整段已加载范围都要重读」;
//   - 追加与前插都按 getKey 去重;
//   - 快照引用稳定:refresh 读回来的行与已有的逐字段相同(键序、状态也没变)时不发布新快照,订阅方不重渲染;
//   - createUserQueryCache(prefix, options):每位用户一份的模块级缓存(forUser 幂等,可在渲染期调用;peek 只取不建;clear 在登出时调用)。
// 不是 zustand store:组件经 usePagedSnapshot(query) = useSyncExternalStore 订阅,快照不可变、无变化时同一引用。
// 模块纯净:不读 window、不发请求(fetchPage 由调用方注入),node 环境可测(paged-query.test.ts)。
import { useSyncExternalStore } from "react";

export type PagedStatus = "idle" | "loading" | "done" | "error";
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PagedSnapshot<T> = { readonly items: readonly T[]; readonly status: PagedStatus; readonly error: string | null };

export type PagedQueryOptions<T> = {
  /** 这份数据的身份(如 `history:<userId>`):调用方按它缓存 / 换新查询,换用户即换 key */
  key: string;
  fetchPage: (cursor: string | null) => Promise<Page<T>>;
  getKey: (item: T) => string;
  /** 可选排序(新 → 旧,与服务端分页同序);给了它,prepend / refresh 合并后重排,markStale 也靠它定位 */
  compare?: (a: T, b: T) => number;
  /** refresh 一次最多连读几页去找接缝,缺省 REFRESH_MAX_PAGES;读满仍接不上就以读到的页替换列表 */
  maxRefreshPages?: number;
};

/** refresh 找接缝的页数上限:每页 50 行时是 250 行;离开期间多出这么多行,替换列表比把它们一页页全拉下来更合适 */
export const REFRESH_MAX_PAGES = 5;

/**
 * markStale 逐条记录的上限(≈ REFRESH_MAX_PAGES × 每页 50 行):历史 Tab 打开过一次之后,账户订阅整场会话都在往里记,
 * 而 Tab 卸载期间没有 refresh 来消化。超过它就只记一个「整段已加载范围都要重读」—— 下一次 refresh 读到已加载的末行为止,
 * 读满 maxRefreshPages 仍不够就以读到的页整体替换。这是保守的做法:数据一定正确(不留洞),但不总与逐条覆盖等价 ——
 * 被标记的行若都在前几页,逐条覆盖在第一页就能接上、保留已加载的全部深度;溢出模式要一路读到已加载的末行,
 * 已加载超过 maxRefreshPages 页时替换会把列表截到这几页,用户翻下去的更深的页要重新加载。以正确换深度,只在溢出时发生。
 */
export const MAX_STALE_ROWS = 256;

export type PagedQuery<T> = {
  readonly key: string;
  readonly items: readonly T[];
  readonly status: PagedStatus;
  readonly error: string | null;
  loadMore(): Promise<void>;
  reset(): void;
  prepend(items: readonly T[]): void;
  /** 读新行到顶上(见文件头);在跑时再调用只记一笔,跑完补跑一次;失败不改状态 */
  refresh(): Promise<void>;
  /** 这些行在已加载范围内的位置上有变化、内容未知:下一次 refresh 读到覆盖它们为止(需要 compare;第一页未加载时忽略) */
  markStale(items: readonly T[]): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): PagedSnapshot<T>;
};

export const EMPTY_PAGED_SNAPSHOT: PagedSnapshot<never> = Object.freeze({ items: Object.freeze([]) as readonly never[], status: "idle", error: null });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

/**
 * 两行内容相同:同一引用,或自有字段一一相同(值是原始类型;数组字段 —— Fill.ledgerRefs —— 逐元素比)。
 * 服务端每次都回新对象,委托 / 成交又都是扁平记录,这一层就够判断「读回来的还是那一行」。
 */
export function sameRow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * 把 incoming 合进 base:已有的键就地替换,新的放最前(保持 incoming 内部顺序);compare 给了就整体重排。
 * 无变化(没有新行,且替换的每一行都与原来的 sameRow)返回 null —— 调用方不发布,快照引用不变。
 */
function mergeOnTop<T>(base: readonly T[], incoming: readonly T[], getKey: (item: T) => string, compare?: (a: T, b: T) => number): T[] | null {
  if (incoming.length === 0) return null;
  const index = new Map<string, number>();
  base.forEach((item, i) => index.set(getKey(item), i));
  const next = base.slice();
  const fresh: T[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const item of incoming) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const at = index.get(key);
    if (at === undefined) fresh.push(item);
    else if (!sameRow(next[at], item)) {
      next[at] = item;
      changed = true;
    }
  }
  if (!fresh.length && !changed) return null;
  const merged = fresh.length ? [...fresh, ...next] : next;
  return compare ? merged.sort(compare) : merged;
}

/** 两个列表逐行相同(同样的键序、每行 sameRow) */
function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => sameRow(item, b[i]));
}

/** 追加一页:已有的键跳过(保留第一份与它的位置) */
function appendUnique<T>(base: readonly T[], page: readonly T[], getKey: (item: T) => string): T[] {
  const seen = new Set(base.map(getKey));
  const out = base.slice();
  for (const item of page) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function createPagedQuery<T>({ key, fetchPage, getKey, compare, maxRefreshPages = REFRESH_MAX_PAGES }: PagedQueryOptions<T>): PagedQuery<T> {
  let snapshot: PagedSnapshot<T> = EMPTY_PAGED_SNAPSHOT;
  let cursor: string | null = null;
  /** 第一页是否已落地(reset 后回到 false):决定 refresh 是头部合并还是等同 loadMore */
  let loaded = false;
  /** 票:reset(与整体替换)一次加一;请求回来时票不对 → 过期,整条丢弃 */
  let ticket = 0;
  let inflight: Promise<void> | null = null;
  /** 在跑的 refresh(同一时刻只跑一个);跑的期间又有人要 → again,跑完补跑一次 */
  let refreshing: Promise<void> | null = null;
  let again = false;
  /** markStale 记下、还没被某次 refresh 覆盖的行,按 getKey(同一行重复标记只留最新一份);seq = 记下它的那次 markStale */
  let stale = new Map<string, { item: T; seq: number }>();
  /** markStale 的调用序号:refresh 只消化它开始之前记下的,跑的期间新记的留给下一次 */
  let staleSeq = 0;
  /** 非 null = 记下的行超过了 MAX_STALE_ROWS,不再逐条记:下一次 refresh 要覆盖整段已加载范围;值是溢出后最近一次标记的序号 */
  let staleOverflowSeq: number | null = null;
  const listeners = new Set<() => void>();

  const publish = (patch: Partial<PagedSnapshot<T>>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const loadMore = (): Promise<void> => {
    if (inflight) return inflight;
    if (snapshot.status === "done") return Promise.resolve();
    const mine = ticket;
    publish({ status: "loading", error: null });
    const run = fetchPage(loaded ? cursor : null).then(
      (page) => {
        if (mine !== ticket) return;
        inflight = null;
        loaded = true;
        cursor = page.nextCursor;
        publish({ items: appendUnique(snapshot.items, page.items, getKey), status: page.nextCursor ? "idle" : "done", error: null });
      },
      (err: unknown) => {
        if (mine !== ticket) return;
        inflight = null;
        publish({ status: "error", error: messageOf(err) });
      },
    );
    inflight = run;
    return run;
  };

  const reset = (): void => {
    ticket++;
    inflight = null;
    cursor = null;
    loaded = false;
    stale = new Map();
    staleOverflowSeq = null;
    again = false;
    if (snapshot === EMPTY_PAGED_SNAPSHOT) return;
    snapshot = EMPTY_PAGED_SNAPSHOT;
    for (const listener of listeners) listener();
  };

  /**
   * 以「从第一页连读下来的若干页」整体替换列表:它本身就是一段不缺行的前缀,游标接在它后面。
   * 换票 —— 在途的 loadMore 读的是旧游标之后的页,落进来会在新列表末尾与它之间留洞,必须作废。
   * 读回来的与现有列表逐行相同、状态也没变(没有在途的 loadMore 被作废)时不发布:快照引用不变,订阅方不重渲染。
   */
  const replaceAll = (items: readonly T[], nextCursor: string | null): void => {
    ticket++;
    inflight = null;
    cursor = nextCursor;
    loaded = true;
    const rows = appendUnique([], items, getKey);
    const status: PagedStatus = nextCursor ? "idle" : "done";
    const unchanged = sameRows(rows, snapshot.items); // 最多 250 行 × 字段的比较,只做一次
    if (status === snapshot.status && snapshot.error === null && unchanged) return;
    publish({ items: unchanged ? snapshot.items : rows, status, error: null });
  };

  const prepend = (items: readonly T[]): void => {
    const merged = mergeOnTop(snapshot.items, items, getKey, compare);
    if (merged) publish({ items: merged });
  };

  const markStale = (items: readonly T[]): void => {
    // 第一页还没读:第一次加载自然会读到它们的终态;没有 compare 定不了位置,只能交给第一页的重读
    if (!loaded || !compare || items.length === 0) return;
    const seq = ++staleSeq;
    if (staleOverflowSeq !== null) {
      staleOverflowSeq = seq;
      return;
    }
    for (const item of items) {
      const key = getKey(item);
      stale.delete(key); // 重复标记只留最新一份(不重复计数)
      stale.set(key, { item, seq });
    }
    if (stale.size > MAX_STALE_ROWS) {
      stale = new Map();
      staleOverflowSeq = seq;
    }
  };

  /**
   * 一次 refresh:从第一页往下读,停在
   *   - 读到底(nextCursor = null):读到的就是整张表 → 整体替换;
   *   - 这一页与开始时已加载的行有重叠(接上了),且 markStale 记下的、落在已加载范围内的行都已被读过的范围覆盖 → 合并到顶上
   *     (记下的行溢出过 MAX_STALE_ROWS:要覆盖到已加载的末行;列表已翻完时要读到底);
   *   - 读满 maxRefreshPages 页仍不满足 → 以读到的页整体替换。
   * 任一页失败或期间 reset:什么都不改(stale 留给下一次),不把接不上的半截合并进来。
   * 成功后只消化开始之前记下的标记;跑的期间新记的留给下一次。
   */
  const refreshOnce = async (): Promise<void> => {
    const mine = ticket;
    const known = new Set(snapshot.items.map(getKey));
    const tail = snapshot.items[snapshot.items.length - 1];
    const complete = snapshot.status === "done";
    const seqAtStart = staleSeq;
    const overflow = staleOverflowSeq !== null;
    // 排在已加载末行之后的(且还没翻完)不用管:loadMore 迟早读到它,读到的就是终态
    const pending: T[] = [];
    if (compare && !overflow) {
      for (const { item } of stale.values()) if (complete || (tail !== undefined && compare(item, tail) <= 0)) pending.push(item);
    }
    const coveredUpTo = (last: T | undefined): boolean => {
      if (overflow) return !complete && compare !== undefined && tail !== undefined && last !== undefined && compare(tail, last) <= 0;
      return compare !== undefined && last !== undefined ? pending.every((item) => compare(item, last) <= 0) : pending.length === 0;
    };
    const collected: T[] = [];
    let next: string | null = null;
    for (let pages = 1; ; pages++) {
      let page: Page<T>;
      try {
        page = await fetchPage(next);
      } catch {
        return; // 尽力而为:失败不改状态,下一次触发再说
      }
      if (mine !== ticket) return;
      collected.push(...page.items);
      next = page.nextCursor;
      if (next === null) {
        replaceAll(collected, null);
        break;
      }
      const joined = page.items.some((item) => known.has(getKey(item)));
      if (joined && coveredUpTo(collected[collected.length - 1])) {
        prepend(collected);
        break;
      }
      if (pages >= maxRefreshPages) {
        replaceAll(collected, next);
        break;
      }
    }
    for (const [key, entry] of stale) if (entry.seq <= seqAtStart) stale.delete(key);
    if (staleOverflowSeq !== null && staleOverflowSeq <= seqAtStart) staleOverflowSeq = null;
  };

  const refresh = (): Promise<void> => {
    if (!loaded) return loadMore();
    if (refreshing) {
      again = true;
      return refreshing;
    }
    const run = (async () => {
      try {
        do {
          again = false;
          await refreshOnce();
        } while (again && loaded);
      } finally {
        refreshing = null;
      }
    })();
    refreshing = run;
    return run;
  };

  return {
    key,
    get items() {
      return snapshot.items;
    },
    get status() {
      return snapshot.status;
    },
    get error() {
      return snapshot.error;
    },
    loadMore,
    reset,
    prepend,
    refresh,
    markStale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

export type UserQueryCache<T> = {
  /** 当前用户的查询;meId 为 null(未登录 / 尚未知)返回 null、不动缓存 */
  forUser(meId: string | null): PagedQuery<T> | null;
  /** 只取不建:这位用户的查询已经存在就给它,否则 null(账户订阅里给已打开过的列表记 markStale 用) */
  peek(meId: string | null): PagedQuery<T> | null;
  /** 作废并丢弃当前实例(登出 / 换号时由账户订阅调用,不在渲染期) */
  clear(): void;
};

/**
 * 按用户缓存一份分页查询(OrderHistoryTab / FillsTab 的模块级缓存,key = `<prefix>:<meId>`):切走 Tab 再回来不重拉、不丢已翻的页。
 * forUser 会在渲染期(useMemo)里被调用,所以它是幂等的:同一 meId 永远返回同一实例,只有第一次调用创建;换了用户返回新实例,
 * 旧的不再被引用;它不通知任何订阅者,渲染期调用不会让别的组件更新。
 * clear 先 reset(换票:在途的响应回来也落不进去),再丢弃引用 —— 上一位用户的委托 / 成交不会留在内存里。
 */
export function createUserQueryCache<T>(prefix: string, options: Omit<PagedQueryOptions<T>, "key">): UserQueryCache<T> {
  let current: PagedQuery<T> | null = null;
  return {
    forUser(meId) {
      if (!meId) return null;
      const key = `${prefix}:${meId}`;
      if (current?.key !== key) current = createPagedQuery({ ...options, key });
      return current;
    },
    peek(meId) {
      return meId && current?.key === `${prefix}:${meId}` ? current : null;
    },
    clear() {
      current?.reset();
      current = null;
    },
  };
}

/**
 * 实时行(store 里的 recentFills 等)与分页行合并:实时在前、按 getKey 去重(实时那份优先)、按 compare 排序。
 * 没有实时行时原样返回分页数组(同一引用,下游 memo 不失效)。
 */
export function mergeNewest<T>(live: readonly T[], paged: readonly T[], getKey: (item: T) => string, compare: (a: T, b: T) => number): readonly T[] {
  if (live.length === 0) return paged;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...live, ...paged]) {
    const key = getKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort(compare);
}

const noopSubscribe = (): (() => void) => () => {};
const emptySnapshot = (): PagedSnapshot<never> => EMPTY_PAGED_SNAPSHOT;

/** 订阅一个查询的快照;query 为 null(未登录 / 尚未知身份)时恒为空快照。服务端快照与客户端同源(查询只在客户端建) */
export function usePagedSnapshot<T>(query: PagedQuery<T> | null): PagedSnapshot<T> {
  return useSyncExternalStore(query ? query.subscribe : noopSubscribe, query ? query.getSnapshot : emptySnapshot, query ? query.getSnapshot : emptySnapshot);
}
