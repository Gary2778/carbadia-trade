import { afterEach, describe, expect, it, vi } from "vitest";
import { singleFlight, singleFlightsInProgress } from "./single-flight";

/** 手动结算的 Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  globalThis.__carbadiaSingleFlight = undefined;
});

describe("singleFlight", () => {
  it("same key while in flight: one execution, every caller gets the same result", async () => {
    const d = deferred<{ n: number }>();
    const run = vi.fn(() => d.promise);
    const calls = [singleFlight("k", run), singleFlight("k", run), singleFlight("k", run)];
    expect(singleFlightsInProgress()).toBe(1);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    const result = { n: 1 };
    d.resolve(result);
    const results = await Promise.all(calls);
    expect(results.every((r) => r === result)).toBe(true);
    expect(singleFlightsInProgress()).toBe(0);
  });

  it("no result caching: a call after the flight settled runs again", async () => {
    let n = 0;
    const run = vi.fn(async () => ++n);
    expect(await singleFlight("k", run)).toBe(1);
    expect(await singleFlight("k", run)).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("different keys do not share", async () => {
    const run = vi.fn(async (value: string) => value);
    const [a, b] = await Promise.all([singleFlight("a", () => run("a")), singleFlight("b", () => run("b"))]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a failure reaches every joined caller and clears the key; the next call runs again", async () => {
    const d = deferred<number>();
    const run = vi.fn(() => d.promise);
    const first = singleFlight("k", run);
    const second = singleFlight("k", run);
    d.reject(new Error("busy"));
    await expect(first).rejects.toThrow("busy");
    await expect(second).rejects.toThrow("busy");
    expect(singleFlightsInProgress()).toBe(0);
    expect(await singleFlight("k", async () => 7)).toBe(7);
  });

  it("a run that throws synchronously still clears its key (no stuck rejected flight)", async () => {
    const boom = () => {
      throw new Error("sync");
    };
    await expect(singleFlight("k", boom)).rejects.toThrow("sync");
    expect(singleFlightsInProgress()).toBe(0);
    expect(await singleFlight("k", async () => "fresh")).toBe("fresh");
  });

  it("state lives on globalThis (one map for every bundle in the process)", () => {
    void singleFlight("k", () => new Promise(() => {}));
    expect(globalThis.__carbadiaSingleFlight?.has("k")).toBe(true);
  });
});
