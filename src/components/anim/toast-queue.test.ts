import { describe, expect, it } from "vitest";
import {
  INITIAL_TOAST_QUEUE,
  TOAST_ACTION_TTL_MS,
  TOAST_MAX,
  TOAST_TTL_MS,
  nextExpiry,
  reduceToastQueue,
  type ToastOptions,
  type ToastQueueState,
} from "./toast-queue";

const push = (state: ToastQueueState, text: string, now = 1_000, opts?: ToastOptions) =>
  reduceToastQueue(state, { kind: "push", type: "ok", text, now, opts });

describe("reduceToastQueue", () => {
  it("appends with increasing ids and the default ttl", () => {
    let s = push(INITIAL_TOAST_QUEUE, "a", 1_000);
    s = push(s, "b", 1_500);
    expect(s.items.map((i) => [i.id, i.text, i.type, i.expiresAt])).toEqual([
      [1, "a", "ok", 1_000 + TOAST_TTL_MS],
      [2, "b", "ok", 1_500 + TOAST_TTL_MS],
    ]);
    expect(s.nextId).toBe(3);
  });

  it("uses ttlMs when given, and a longer default when the toast carries an action", () => {
    const onClick = () => {};
    let s = push(INITIAL_TOAST_QUEUE, "a", 1_000, { ttlMs: 250 });
    s = push(s, "b", 1_000, { action: { label: "Undo", onClick } });
    expect(s.items[0].expiresAt).toBe(1_250);
    expect(s.items[1].expiresAt).toBe(1_000 + TOAST_ACTION_TTL_MS);
    expect(s.items[1].action?.label).toBe("Undo");
  });

  it("refreshes an existing toast with the same dedupeKey instead of stacking a second one", () => {
    let s = push(INITIAL_TOAST_QUEUE, "first", 1_000);
    s = push(s, "lost", 1_000, { dedupeKey: "conn" });
    s = push(s, "third", 1_000);
    s = reduceToastQueue(s, { kind: "push", type: "warning", text: "still lost", now: 2_000, opts: { dedupeKey: "conn" } });
    expect(s.items).toHaveLength(3);
    expect(s.items.map((i) => i.text)).toEqual(["first", "still lost", "third"]); // 原位更新,顺序不变
    expect(s.items[1]).toMatchObject({ id: 2, type: "warning", dedupeKey: "conn", expiresAt: 2_000 + TOAST_TTL_MS });
    expect(s.nextId).toBe(4); // 没有分配新 id
  });

  it("keeps at most TOAST_MAX toasts, dropping the oldest first", () => {
    let s = INITIAL_TOAST_QUEUE;
    for (let n = 1; n <= TOAST_MAX + 2; n++) s = push(s, `t${n}`, 1_000 + n);
    expect(s.items).toHaveLength(TOAST_MAX);
    expect(s.items.map((i) => i.text)).toEqual(["t3", "t4", "t5", "t6", "t7"]);
  });

  it("dedupe refresh never evicts: the refreshed toast keeps its slot even when the queue is full", () => {
    let s = INITIAL_TOAST_QUEUE;
    s = push(s, "keyed", 1_000, { dedupeKey: "k" });
    for (let n = 1; n < TOAST_MAX; n++) s = push(s, `t${n}`, 1_000 + n);
    expect(s.items).toHaveLength(TOAST_MAX);
    s = push(s, "keyed again", 5_000, { dedupeKey: "k" });
    expect(s.items).toHaveLength(TOAST_MAX);
    expect(s.items[0]).toMatchObject({ id: 1, text: "keyed again" });
  });

  it("expire removes only the toasts whose ttl has elapsed and returns the same state when nothing changed", () => {
    let s = push(INITIAL_TOAST_QUEUE, "a", 1_000, { ttlMs: 1_000 });
    s = push(s, "b", 1_000, { ttlMs: 3_000 });
    const untouched = reduceToastQueue(s, { kind: "expire", now: 1_500 });
    expect(untouched).toBe(s);
    const later = reduceToastQueue(s, { kind: "expire", now: 2_000 }); // a 在 2_000 到期(<=),b 还在
    expect(later.items.map((i) => i.text)).toEqual(["b"]);
    expect(reduceToastQueue(later, { kind: "expire", now: 4_000 }).items).toEqual([]);
  });

  it("dismiss removes one toast by id and is a no-op for unknown ids", () => {
    let s = push(INITIAL_TOAST_QUEUE, "a");
    s = push(s, "b");
    const gone = reduceToastQueue(s, { kind: "dismiss", id: 1 });
    expect(gone.items.map((i) => i.text)).toEqual(["b"]);
    expect(reduceToastQueue(gone, { kind: "dismiss", id: 42 })).toBe(gone);
  });

  it("expire at exactly nextExpiry always removes the earliest toast, so a timer armed for that instant never fires into a no-op", () => {
    // Provider 把回调里的 now 钳到 >= at(墙钟回拨 / 降精度时钟);这里锁住 reducer 一侧的契约:
    // now === nextExpiry(state) 时至少去掉最早那条,返回新引用,effect 才会为下一条重新布计时器。
    let s = push(INITIAL_TOAST_QUEUE, "a", 1_000, { ttlMs: 250 });
    s = push(s, "b", 1_000, { ttlMs: 3_000 });
    const at = nextExpiry(s);
    expect(at).toBe(1_250);
    const next = reduceToastQueue(s, { kind: "expire", now: at! });
    expect(next).not.toBe(s);
    expect(next.items.map((i) => i.text)).toEqual(["b"]);
    expect(nextExpiry(next)).toBe(4_000);
  });

  it("nextExpiry reports the earliest deadline or null for an empty queue", () => {
    expect(nextExpiry(INITIAL_TOAST_QUEUE)).toBeNull();
    let s = push(INITIAL_TOAST_QUEUE, "a", 1_000, { ttlMs: 5_000 });
    s = push(s, "b", 1_000, { ttlMs: 2_000 });
    expect(nextExpiry(s)).toBe(3_000);
  });

  it("does not mutate the previous state", () => {
    const s = push(INITIAL_TOAST_QUEUE, "a");
    const frozenItems = Object.freeze([...s.items]);
    const frozen: ToastQueueState = Object.freeze({ items: frozenItems as ToastQueueState["items"], nextId: s.nextId });
    expect(() => push(frozen, "b", 1_000, { dedupeKey: "x" })).not.toThrow();
    expect(() => reduceToastQueue(frozen, { kind: "expire", now: 99_999 })).not.toThrow();
    expect(frozen.items).toHaveLength(1);
  });
});
