// 读取边界的收窄与白名单映射(计划 §3.4 / §9.1 第 15 条):
// 核证状态列是自由 TEXT, 只有 "SIMULATED_UNVERIFIED" 原样通过; toInstrument 显式取字段, 不 spread 数据库整行。
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTRUMENT_SELECT, narrowVerification, toInstrument, type InstrumentRow } from "./instrument-select";

const row = (overrides: Partial<InstrumentRow> = {}): InstrumentRow => ({
  id: "a1",
  symbol: "VCS-FOR-2021",
  name: "云南森林经营碳汇项目",
  standard: "VCS",
  projectType: "林业碳汇",
  vintage: 2021,
  country: "中国",
  registry: "Verra",
  isScenario: false,
  projectId: "SIM-PRJ-VCS-FOR",
  methodology: null,
  verificationStatus: null,
  tickSize: 1,
  pricePrecision: 2,
  qtyStep: 1,
  minQty: 1,
  currency: "USD",
  lastPrice: 6800,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("INSTRUMENT_SELECT", () => {
  it("恰好 18 个字段, 且不含 anchorPrice / description / createdAt", () => {
    const keys = Object.keys(INSTRUMENT_SELECT).sort();
    expect(keys).toHaveLength(18);
    expect(keys).not.toContain("anchorPrice");
    expect(keys).not.toContain("description");
    expect(keys).not.toContain("createdAt");
    expect(Object.values(INSTRUMENT_SELECT).every((v) => v === true)).toBe(true);
  });
});

describe("narrowVerification", () => {
  it("合法字面量原样返回", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(narrowVerification("SIMULATED_UNVERIFIED")).toBe("SIMULATED_UNVERIFIED");
    expect(warn).not.toHaveBeenCalled();
  });

  it("null 返回 null 且不告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(narrowVerification(null)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("非法字符串(含真实核证状态)收窄为 null, 同一值只告警一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(narrowVerification("VERIFIED")).toBeNull();
    expect(narrowVerification("VERIFIED")).toBeNull();
    expect(narrowVerification("")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2); // "VERIFIED" 一次, "" 一次
    expect(String(warn.mock.calls[0][0])).toContain("[instruments]");
  });
});

describe("toInstrument", () => {
  it("输出恰为 Instrument 的 18 个键, 数据库整行的多余字段被丢弃", () => {
    // 模拟误传整行(含锚定价、描述、创建时间): 映射必须显式取字段而不是 spread
    const leaked = { ...row(), anchorPrice: 6800, description: "内部", createdAt: new Date() };
    const out = toInstrument(leaked);
    expect("anchorPrice" in out).toBe(false);
    expect("description" in out).toBe(false);
    expect("createdAt" in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(Object.keys(INSTRUMENT_SELECT).sort());
    expect(out).toMatchObject({ symbol: "VCS-FOR-2021", projectId: "SIM-PRJ-VCS-FOR", currency: "USD", lastPrice: 6800 });
  });

  it("verificationStatus 经 narrowVerification 收窄", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(toInstrument(row({ verificationStatus: "SIMULATED_UNVERIFIED" })).verificationStatus).toBe("SIMULATED_UNVERIFIED");
    expect(toInstrument(row({ verificationStatus: "Gold Standard verified" })).verificationStatus).toBeNull();
    expect(toInstrument(row({ verificationStatus: null })).verificationStatus).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("currency 列非 USD 时告警并按 Phase 1 的全站 USD 输出", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(toInstrument(row({ currency: "EUR" })).currency).toBe("USD");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
