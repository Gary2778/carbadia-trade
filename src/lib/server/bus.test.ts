// server/bus.mjs 的扇出语义,以及 src/lib/server/bus.ts 的 getBus() 与 server.mjs 共用 globalThis.__carbadiaBus 这一份实例。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusMessage, CarbadiaBus } from "../../shared/bus";
import { createBus } from "../../../server/bus.mjs";
import { getBus } from "./bus";

const ticker = (symbol: string): BusMessage => ({ kind: "ticker", symbol, ticker: { symbol, ts: 1_700_000_000_000, lastPrice: 6800 } });
const label = (m: BusMessage) => (m.kind === "account" ? m.userId : m.symbol);

describe("createBus", () => {
  it("订阅者按订阅顺序同步收到每条消息", () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.subscribe((m) => seen.push(`a:${label(m)}`));
    bus.subscribe((m) => seen.push(`b:${label(m)}`));
    bus.publish(ticker("VCS-FOR-2021"));
    expect(seen).toEqual(["a:VCS-FOR-2021", "b:VCS-FOR-2021"]); // publish 返回时已经送达:同步扇出
  });

  it("退订后不再收到;重复退订无副作用", () => {
    const bus = createBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish(ticker("A"));
    off();
    off();
    bus.publish(ticker("B"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("订阅者异常被隔离:其余订阅者照常收到,异常计数 +1", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createBus();
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(after);
    expect(() => bus.publish(ticker("A"))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(bus.subscriberErrors()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("订阅者持续抛异常时日志限流:前 10 次逐条记,之后每分钟至多一条;计数不受影响", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bus = createBus();
      bus.subscribe(() => {
        throw new Error("boom");
      });
      for (let i = 0; i < 500; i++) bus.publish(ticker("A"));
      expect(bus.subscriberErrors()).toBe(500);
      expect(error).toHaveBeenCalledTimes(10); // 500 次异常只有 10 行日志
      vi.advanceTimersByTime(59_000);
      bus.publish(ticker("A"));
      expect(error).toHaveBeenCalledTimes(10); // 未满一分钟不再记
      vi.advanceTimersByTime(1_000);
      bus.publish(ticker("A"));
      expect(error).toHaveBeenCalledTimes(11); // 满一分钟记一条,并带累计次数
      expect(String(error.mock.calls[10][0])).toContain("(502 so far)");
      bus.publish(ticker("A"));
      expect(error).toHaveBeenCalledTimes(11);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it("hasSubscribers 跟随订阅集合", () => {
    const bus = createBus();
    expect(bus.hasSubscribers()).toBe(false);
    const off = bus.subscribe(() => {});
    expect(bus.hasSubscribers()).toBe(true);
    off();
    expect(bus.hasSubscribers()).toBe(false);
  });

  it("没有 class:实例是普通对象,方法可解构使用", () => {
    const bus = createBus();
    expect(Object.getPrototypeOf(bus)).toBe(Object.prototype);
    const { publish, subscribe, hasSubscribers } = bus;
    const fn = vi.fn();
    subscribe(fn);
    publish(ticker("A"));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(hasSubscribers()).toBe(true);
  });
});

describe("getBus 与 globalThis.__carbadiaBus", () => {
  let prev: CarbadiaBus | undefined;
  beforeEach(() => {
    prev = globalThis.__carbadiaBus;
    globalThis.__carbadiaBus = undefined;
  });
  afterEach(() => {
    globalThis.__carbadiaBus = prev;
  });

  it("首次调用创建并挂到 globalThis,之后复用同一实例", () => {
    const bus = getBus();
    expect(globalThis.__carbadiaBus).toBe(bus);
    expect(getBus()).toBe(bus);
  });

  it("server.mjs 先创建的实例被 bundle 侧直接命中(不新建)", () => {
    const fromServer = createBus();
    globalThis.__carbadiaBus = fromServer;
    expect(getBus()).toBe(fromServer);
  });

  it("两份模块副本(两个 bundle)共享同一实例:一边订阅,另一边发布", async () => {
    const first = getBus();
    vi.resetModules();
    const { getBus: getBusAgain } = await import("./bus");
    const second = getBusAgain();
    expect(second).toBe(first);
    const fn = vi.fn();
    first.subscribe(fn);
    second.publish(ticker("A"));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
