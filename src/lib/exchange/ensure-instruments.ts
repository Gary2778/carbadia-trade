// 启动幂等 ensure 与多 vintage 种子(计划 §3.4「幂等 ensure 与多 vintage 种子」、§9.1 第 15 条)。
// 同一项目的多个 vintage 靠 projectId(SIM-PRJ-<STANDARD>-<TYPE>, 模拟编号)归组; methodology / verificationStatus 全 null,
// 不填任何真实登记数据。prisma/seed.ts 的 ASSETS 与这里同源。
//
// 写入规则(决策备忘录 V8): 新 symbol 才写全字段(含一次性的 lastPrice / anchorPrice = mid);
// 既有 symbol 只回填 projectId 为空的行的元数据列; 永不写 methodology / verificationStatus / lastPrice / anchorPrice
// (前两者是 null 的诚实承诺, 后两者是模拟盘自己的市场状态, 任何"刷新"都是外部价格注入)。
// 情景标的(shadow.ts 的 ensureScenarioAssets, update: {})不在这里, 也不加 vintage。

export type InstrumentSeed = {
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  /** 初始中间价(分): 只在首次创建时写入 lastPrice / anchorPrice */
  mid: number;
  projectId: string;
  methodology: null;
  verificationStatus: null;
  tickSize: number;
  pricePrecision: number;
  qtyStep: number;
  minQty: number;
  currency: "USD";
};

const PRECISION = { tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD" } as const;
const UNVERIFIED = { methodology: null, verificationStatus: null } as const;

const seed = (
  symbol: string,
  name: string,
  standard: string,
  projectType: string,
  vintage: number,
  country: string,
  registry: string,
  mid: number,
  projectId: string,
): InstrumentSeed => ({ symbol, name, standard, projectType, vintage, country, registry, mid, projectId, ...UNVERIFIED, ...PRECISION });

/** 12 条: 6 既有 + 6 同项目多 vintage; 中间价(分)按计划 §9.1 第 15 条 */
export const INSTRUMENT_SEEDS: readonly InstrumentSeed[] = [
  seed("VCS-FOR-2021", "云南森林经营碳汇项目", "VCS", "林业碳汇", 2021, "中国", "Verra", 6800, "SIM-PRJ-VCS-FOR"),
  seed("VCS-FOR-2022", "云南森林经营碳汇项目", "VCS", "林业碳汇", 2022, "中国", "Verra", 7000, "SIM-PRJ-VCS-FOR"),
  seed("VCS-FOR-2023", "云南森林经营碳汇项目", "VCS", "林业碳汇", 2023, "中国", "Verra", 7250, "SIM-PRJ-VCS-FOR"),
  seed("CCER-SOL-2022", "青海光伏发电项目", "CCER", "可再生能源", 2022, "中国", "国家温室气体自愿减排登记簿", 8000, "SIM-PRJ-CCER-SOL"),
  seed("CCER-SOL-2023", "青海光伏发电项目", "CCER", "可再生能源", 2023, "中国", "国家温室气体自愿减排登记簿", 8200, "SIM-PRJ-CCER-SOL"),
  seed("GS-WIND-2022", "印度拉贾斯坦风电项目", "GS", "可再生能源", 2022, "印度", "Gold Standard", 4500, "SIM-PRJ-GS-WIND"),
  seed("GS-WIND-2023", "印度拉贾斯坦风电项目", "GS", "可再生能源", 2023, "印度", "Gold Standard", 4650, "SIM-PRJ-GS-WIND"),
  seed("GS-MANG-2022", "印尼红树林蓝碳修复", "GS", "蓝碳", 2022, "印度尼西亚", "Gold Standard", 9500, "SIM-PRJ-GS-MANG"),
  seed("GS-MANG-2023", "印尼红树林蓝碳修复", "GS", "蓝碳", 2023, "印度尼西亚", "Gold Standard", 9800, "SIM-PRJ-GS-MANG"),
  seed("VCS-COOK-2020", "肯尼亚高效炉灶项目", "VCS", "能效", 2020, "肯尼亚", "Verra", 1200, "SIM-PRJ-VCS-COOK"),
  seed("VCS-COOK-2021", "肯尼亚高效炉灶项目", "VCS", "能效", 2021, "肯尼亚", "Verra", 1250, "SIM-PRJ-VCS-COOK"),
  seed("CDM-METH-2019", "巴西垃圾填埋气回收", "CDM", "甲烷回收", 2019, "巴西", "UNFCCC", 900, "SIM-PRJ-CDM-METH"),
];

/**
 * 幂等: 空库 → 全部创建; 再跑 → 什么都不动; 迁移前的旧行(projectId 为 null)→ 只回填元数据列。
 * 返回被创建 / 被回填的 symbol 列表, 由 instrumentation 打一行 [instruments] created=<n> backfilled=<n>。
 */
export async function ensureInstruments(): Promise<{ created: string[]; backfilled: string[] }> {
  const { prisma } = await import("../server/db"); // 延迟加载: seed.ts 只取 INSTRUMENT_SEEDS, 不拉起应用的 PrismaClient
  const created: string[] = [];
  const backfilled: string[] = [];
  for (const s of INSTRUMENT_SEEDS) {
    const { mid, ...fields } = s;
    const existing = await prisma.asset.findUnique({ where: { symbol: s.symbol }, select: { id: true } });
    if (!existing) {
      // upsert 而非 create: 并发启动(部署重叠期)下另一实例先建了也不抛; update 恒空, 存在即不动
      await prisma.asset.upsert({
        where: { symbol: s.symbol },
        create: { ...fields, lastPrice: mid, anchorPrice: mid },
        update: {},
      });
      created.push(s.symbol);
      continue;
    }
    const r = await prisma.asset.updateMany({
      where: { symbol: s.symbol, projectId: null },
      data: { projectId: s.projectId, tickSize: s.tickSize, pricePrecision: s.pricePrecision, qtyStep: s.qtyStep, minQty: s.minQty, currency: s.currency },
    });
    if (r.count > 0) backfilled.push(s.symbol);
  }
  return { created, backfilled };
}
