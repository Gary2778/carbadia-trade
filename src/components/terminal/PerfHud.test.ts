import { describe, expect, it } from "vitest";
import { createFrameMeter, percentile } from "./PerfHud";

describe("createFrameMeter(PerfHud 的帧统计,计划 §7.3)", () => {
  it("相邻间隔 > 20 ms 记慢帧、> 50 ms 记长帧;第一次回调只起算;take() 交出当前桶并清零", () => {
    const m = createFrameMeter();
    m.frame(0);
    m.frame(16);
    m.frame(40); // 24 ms:慢帧
    m.frame(100); // 60 ms:慢帧 + 长帧
    expect(m.take()).toEqual({ frames: 3, slow: 2, long: 1 });
    expect(m.take()).toEqual({ frames: 0, slow: 0, long: 0 });
    m.frame(116); // 跨桶仍接着上一帧算间隔
    expect(m.take()).toEqual({ frames: 1, slow: 0, long: 0 });
  });

  it("reset() 之后的第一次回调不计间隔:标签页隐藏数秒后回来,不算一次长帧", () => {
    const m = createFrameMeter();
    m.frame(0);
    m.frame(16);
    m.reset(); // visibilitychange → hidden
    m.reset(); // visibilitychange → visible
    m.frame(8_000);
    m.frame(8_016);
    expect(m.take()).toEqual({ frames: 2, slow: 0, long: 0 });

    // 对照:不 reset 时同样的时间戳会记一次长帧
    const control = createFrameMeter();
    for (const stamp of [0, 16, 8_000, 8_016]) control.frame(stamp);
    expect(control.take()).toEqual({ frames: 3, slow: 1, long: 1 });
  });
});

describe("percentile", () => {
  it("最近秩法;空样本 null", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });
});
