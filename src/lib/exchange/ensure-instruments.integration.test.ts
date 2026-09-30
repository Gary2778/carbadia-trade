// 对真实 SQLite(临时库 + migrate deploy)验证 ensureInstruments 的幂等与"永不覆盖"规则(计划 §3.4、备忘录 V8)。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${database.path}` }) };
});

let prisma: (typeof import("../server/db"))["prisma"];
let ensureInstruments: (typeof import("./ensure-instruments"))["ensureInstruments"];
let INSTRUMENT_SEEDS: (typeof import("./ensure-instruments"))["INSTRUMENT_SEEDS"];

beforeAll(async () => {
  database.directory = mkdtempSync(join(tmpdir(), "carbadia-ensure-instruments-"));
  database.path = join(database.directory, "ensure.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("../server/db"));
  ({ ensureInstruments, INSTRUMENT_SEEDS } = await import("./ensure-instruments"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

describe("INSTRUMENT_SEEDS", () => {
  it("12 条, symbol 唯一, 六个项目里五个有 ≥2 个 vintage(CDM-METH 按计划只有 2019), 登记数据全 null, 全 USD", () => {
    expect(INSTRUMENT_SEEDS).toHaveLength(12);
    expect(new Set(INSTRUMENT_SEEDS.map((s) => s.symbol)).size).toBe(12);
    const byProject = new Map<string, number[]>();
    for (const s of INSTRUMENT_SEEDS) {
      expect(s.projectId).toMatch(/^SIM-PRJ-[A-Z]+-[A-Z]+$/);
      expect(s.projectId).toBe(`SIM-PRJ-${s.standard}-${s.symbol.split("-")[1]}`);
      expect(s.methodology).toBeNull();
      expect(s.verificationStatus).toBeNull();
      expect(s).toMatchObject({ tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD" });
      expect(Number.isInteger(s.mid) && s.mid > 0).toBe(true);
      byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s.vintage]);
    }
    expect(byProject.size).toBe(6);
    for (const vintages of byProject.values()) expect(new Set(vintages).size).toBe(vintages.length); // 同项目不同 vintage
    const multi = [...byProject.entries()].filter(([, v]) => v.length >= 2).map(([pid]) => pid).sort();
    expect(multi).toEqual(["SIM-PRJ-CCER-SOL", "SIM-PRJ-GS-MANG", "SIM-PRJ-GS-WIND", "SIM-PRJ-VCS-COOK", "SIM-PRJ-VCS-FOR"]);
    expect(byProject.get("SIM-PRJ-CDM-METH")).toEqual([2019]);
    expect(INSTRUMENT_SEEDS.filter((s) => s.projectId === "SIM-PRJ-VCS-FOR").map((s) => s.symbol).sort()).toEqual([
      "VCS-FOR-2021", "VCS-FOR-2022", "VCS-FOR-2023",
    ]);
  });
});

describe("ensureInstruments", () => {
  it("空库 → 12 created, 0 backfilled; 初始价一次性写入 lastPrice 与 anchorPrice", async () => {
    const r = await ensureInstruments();
    expect(r.created.sort()).toEqual(INSTRUMENT_SEEDS.map((s) => s.symbol).sort());
    expect(r.backfilled).toEqual([]);
    const rows = await prisma.asset.findMany({ orderBy: { symbol: "asc" } });
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const s = INSTRUMENT_SEEDS.find((x) => x.symbol === row.symbol)!;
      expect(row).toMatchObject({
        name: s.name, standard: s.standard, projectType: s.projectType, vintage: s.vintage, country: s.country, registry: s.registry,
        projectId: s.projectId, methodology: null, verificationStatus: null,
        tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD",
        lastPrice: s.mid, anchorPrice: s.mid, isScenario: false,
      });
    }
  });

  it("再跑 → 0 created, 0 backfilled", async () => {
    const r = await ensureInstruments();
    expect(r).toEqual({ created: [], backfilled: [] });
  });

  it("手改 lastPrice / anchorPrice / methodology / verificationStatus 后 ensure 不覆盖", async () => {
    await prisma.asset.update({
      where: { symbol: "VCS-FOR-2021" },
      data: { lastPrice: 1, anchorPrice: 2, methodology: "手工方法学", verificationStatus: "VERIFIED" },
    });
    const r = await ensureInstruments();
    expect(r).toEqual({ created: [], backfilled: [] });
    const row = await prisma.asset.findUniqueOrThrow({ where: { symbol: "VCS-FOR-2021" } });
    expect(row).toMatchObject({ lastPrice: 1, anchorPrice: 2, methodology: "手工方法学", verificationStatus: "VERIFIED" });
  });

  it("迁移前的旧行(projectId 为 null)只回填元数据列, 市场状态一个字段都不动", async () => {
    // 模拟旧库: 一行按旧 seed 形态存在(无 projectId, 精度列是 DDL 默认值), lastPrice 已被市场推离锚定价
    await prisma.asset.update({
      where: { symbol: "GS-WIND-2022" },
      data: { projectId: null, lastPrice: 4530, anchorPrice: 4500, methodology: null, verificationStatus: null },
    });
    const r = await ensureInstruments();
    expect(r).toEqual({ created: [], backfilled: ["GS-WIND-2022"] });
    const row = await prisma.asset.findUniqueOrThrow({ where: { symbol: "GS-WIND-2022" } });
    expect(row).toMatchObject({
      projectId: "SIM-PRJ-GS-WIND", tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD",
      lastPrice: 4530, anchorPrice: 4500, methodology: null, verificationStatus: null,
    });
  });

  it("库里多 vintage 项目的 symbol ≥ 2, 情景标的不参与", async () => {
    await prisma.asset.create({
      data: { symbol: "CEA-SCEN-2026", name: "情景", standard: "CEA", projectType: "配额情景", vintage: 2026, country: "中国", registry: "情景标的(无真实登记)", lastPrice: 9000, anchorPrice: null, isScenario: true },
    });
    const r = await ensureInstruments();
    expect(r).toEqual({ created: [], backfilled: [] });
    const groups = await prisma.asset.groupBy({ by: ["projectId"], _count: { _all: true } });
    const byProject = Object.fromEntries(groups.map((g) => [g.projectId ?? "null", g._count._all]));
    expect(byProject["null"]).toBe(1); // 只有情景标的没有 projectId
    for (const pid of ["SIM-PRJ-CCER-SOL", "SIM-PRJ-GS-MANG", "SIM-PRJ-GS-WIND", "SIM-PRJ-VCS-COOK"]) expect(byProject[pid]).toBe(2);
    expect(byProject["SIM-PRJ-VCS-FOR"]).toBe(3);
    expect(byProject["SIM-PRJ-CDM-METH"]).toBe(1);
    expect(await prisma.asset.count()).toBe(13); // 12 + 1 情景
  });
});
