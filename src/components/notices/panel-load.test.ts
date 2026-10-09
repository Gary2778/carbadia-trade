import { describe, expect, it } from "vitest";
import { reducePanelLoad, startPanelLoad, type PanelLoad, type PanelLoadAction } from "./panel-load";

// 铃铛加载面板 chunk 的状态机:失败后重试要真的重新开始一次(带新的尝试序号),迟到的上一次结果丢弃;已经加载过就直接 ready。
const run = (actions: PanelLoadAction[], from: PanelLoad = startPanelLoad(false)) => actions.reduce(reducePanelLoad, from);

describe("reducePanelLoad", () => {
  it("starts loading attempt 0, or ready when the panel module is already in", () => {
    expect(startPanelLoad(false)).toEqual({ phase: "loading", attempt: 0 });
    expect(startPanelLoad(true)).toEqual({ phase: "ready" });
  });

  it("becomes ready when the import of the current attempt succeeds", () => {
    expect(run([{ kind: "loaded", attempt: 0 }])).toEqual({ phase: "ready" });
  });

  it("a failed import shows the failure; retry starts a new attempt (which is what makes the effect import again)", () => {
    const failed = run([{ kind: "failed", attempt: 0 }]);
    expect(failed).toEqual({ phase: "failed", attempt: 0 });
    const retrying = run([{ kind: "retry" }], failed);
    expect(retrying).toEqual({ phase: "loading", attempt: 1 });
    expect(run([{ kind: "loaded", attempt: 1 }], retrying)).toEqual({ phase: "ready" });
    // 再失败一次,再重试:序号继续往上
    expect(run([{ kind: "failed", attempt: 1 }, { kind: "retry" }], retrying)).toEqual({ phase: "loading", attempt: 2 });
  });

  it("a late result of an earlier attempt never overrides the current one", () => {
    const retrying = run([{ kind: "failed", attempt: 0 }, { kind: "retry" }]);
    expect(reducePanelLoad(retrying, { kind: "loaded", attempt: 0 })).toBe(retrying);
    expect(reducePanelLoad(retrying, { kind: "failed", attempt: 0 })).toBe(retrying);
  });

  it("retry only means something after a failure; results after ready or for nothing in flight change nothing", () => {
    const loading = startPanelLoad(false);
    expect(reducePanelLoad(loading, { kind: "retry" })).toBe(loading);
    const ready: PanelLoad = { phase: "ready" };
    for (const action of [{ kind: "retry" }, { kind: "loaded", attempt: 0 }, { kind: "failed", attempt: 0 }] as const) expect(reducePanelLoad(ready, action)).toBe(ready);
    const failed: PanelLoad = { phase: "failed", attempt: 0 };
    expect(reducePanelLoad(failed, { kind: "loaded", attempt: 0 })).toBe(failed);
    expect(reducePanelLoad(failed, { kind: "failed", attempt: 0 })).toBe(failed);
  });
});
