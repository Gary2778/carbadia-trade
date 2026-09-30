// instrumentation.register() 的启动顺序(P1-25e):ensureInstruments 之后先预读一次 listInstruments() 填满标的缓存,
// 再起机器人与影子同步 —— hub 据此核实 symbol。生产下 listen 不等 register(见 instrumentation.ts 的注释),
// 但 HTTP 请求(含健康检查)会等,所以流量切过来时列表已在缓存里。预读失败只告警,不挡启动。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const fail = vi.hoisted(() => ({ list: false }));

vi.mock("./lib/exchange/ensure-instruments", () => ({
  ensureInstruments: async () => {
    calls.push("ensureInstruments");
    return { created: [], backfilled: [] };
  },
}));
vi.mock("./lib/server/market-snapshots", () => ({
  listInstruments: async () => {
    await Promise.resolve();
    if (fail.list) throw new Error("db down");
    calls.push("listInstruments");
    return { instruments: [], feeSchedule: {}, serverTime: 0 };
  },
}));
vi.mock("./lib/exchange/bot", () => ({ startMarketBot: () => void calls.push("startMarketBot") }));
vi.mock("./lib/real-sync", () => ({ startRealSync: () => void calls.push("startRealSync") }));

import { register } from "./instrumentation";

beforeEach(() => {
  calls.length = 0;
  fail.list = false;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("BOT_DISABLED", "0");
  vi.stubEnv("SYNC_DISABLED", "1");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("register()", () => {
  it("ensureInstruments → listInstruments(预读,awaited)→ 机器人;预读完成打一行 [instruments] listed=<n>", async () => {
    await register();
    expect(calls).toEqual(["ensureInstruments", "listInstruments", "startMarketBot"]);
    expect(console.log).toHaveBeenCalledWith("[instruments] listed=0");
  });

  it("BOT_DISABLED=1 时照样预读(与机器人无关)", async () => {
    vi.stubEnv("BOT_DISABLED", "1");
    await register();
    expect(calls).toEqual(["ensureInstruments", "listInstruments"]);
  });

  it("预读失败只告警,机器人照常启动", async () => {
    fail.list = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    expect(calls).toEqual(["ensureInstruments", "startMarketBot"]);
    expect(errors).toHaveBeenCalledWith("[instruments] 预读标的列表失败", expect.any(Error));
  });

  it("构建期与 edge runtime 什么都不做", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(calls).toEqual([]);
  });
});
