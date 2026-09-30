// Toast 队列的纯 reducer:去重、上限、到期全在这里,不碰 React、不读时钟(now 由派发方传入),
// 所以能在 node 环境直接测。Provider(Toast.tsx)只负责派发与计时。

export type ToastType = "ok" | "err" | "info" | "warning";

export type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  /** 可选动作按钮(点击后该条 toast 立即消失) */
  action?: ToastAction;
  /** 同键的 toast 只原位刷新(文案 / 类型 / 到期时刻),不叠加第二条 */
  dedupeKey?: string;
  /** 存活毫秒数;缺省 TOAST_TTL_MS,带动作时 TOAST_ACTION_TTL_MS */
  ttlMs?: number;
};

export type ToastItem = {
  id: number;
  type: ToastType;
  text: string;
  action?: ToastAction;
  dedupeKey?: string;
  /** unix ms;expire 动作按 now >= expiresAt 清扫 */
  expiresAt: number;
};

export type ToastQueueState = { items: ToastItem[]; nextId: number };

export type ToastQueueAction =
  | { kind: "push"; type: ToastType; text: string; now: number; opts?: ToastOptions }
  | { kind: "dismiss"; id: number }
  | { kind: "expire"; now: number };

/** 同时可见的上限,超出淘汰最旧的 */
export const TOAST_MAX = 5;
/** 无动作 toast 的默认存活时长(沿用旧 Toast 的 3.2 s) */
export const TOAST_TTL_MS = 3200;
/** 带动作按钮的默认存活时长:给用户留出看清并点击的时间 */
export const TOAST_ACTION_TTL_MS = 8000;

export const INITIAL_TOAST_QUEUE: ToastQueueState = { items: [], nextId: 1 };

export function reduceToastQueue(state: ToastQueueState, action: ToastQueueAction): ToastQueueState {
  switch (action.kind) {
    case "push": {
      const opts = action.opts ?? {};
      const ttl = opts.ttlMs ?? (opts.action ? TOAST_ACTION_TTL_MS : TOAST_TTL_MS);
      const patch = { type: action.type, text: action.text, action: opts.action, dedupeKey: opts.dedupeKey, expiresAt: action.now + ttl };
      const at = opts.dedupeKey === undefined ? -1 : state.items.findIndex((item) => item.dedupeKey === opts.dedupeKey);
      if (at !== -1) {
        // 原位刷新:保留 id 与位置,不分配新 id,也不触发淘汰
        const items = state.items.slice();
        items[at] = { ...items[at], ...patch };
        return { items, nextId: state.nextId };
      }
      const items = [...state.items, { id: state.nextId, ...patch }];
      return { items: items.length > TOAST_MAX ? items.slice(items.length - TOAST_MAX) : items, nextId: state.nextId + 1 };
    }
    case "dismiss": {
      const items = state.items.filter((item) => item.id !== action.id);
      return items.length === state.items.length ? state : { items, nextId: state.nextId };
    }
    case "expire": {
      const items = state.items.filter((item) => item.expiresAt > action.now);
      return items.length === state.items.length ? state : { items, nextId: state.nextId };
    }
  }
}

/** 播报方式(§4.5):ok / info 礼貌播报(role="status"),err / warning 打断播报(role="alert") */
export const TOAST_LIVE: Record<ToastType, "status" | "alert"> = { ok: "status", info: "status", err: "alert", warning: "alert" };

/**
 * 纯函数:按播报方式把队列分进两个常驻 live region,各自保持队列顺序。
 * 角色挂在区域上、不挂在条目上:区域里再套一个带角色的条目就是 live region 嵌套,读屏可能读两遍。
 */
export function splitToastRegions(items: readonly ToastItem[]): Record<"status" | "alert", ToastItem[]> {
  const out: Record<"status" | "alert", ToastItem[]> = { status: [], alert: [] };
  for (const item of items) out[TOAST_LIVE[item.type]].push(item);
  return out;
}

/** 最近的到期时刻(unix ms);队列为空时 null。Provider 只对这一刻设一个计时器。 */
export function nextExpiry(state: ToastQueueState): number | null {
  let min: number | null = null;
  for (const item of state.items) if (min === null || item.expiresAt < min) min = item.expiresAt;
  return min;
}
