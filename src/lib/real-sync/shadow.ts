// 影子价格实验: 情景标的 ensure + 每日快照(影子收盘/量)+ 真实市场收盘的内部对照采集。
//
// ===== 诚实性铁律(本文件的存在意义, 改动前必读) =====
// 1. 真实市场价格**永不**写入 Asset 表、bot 报价、或任何影响模拟盘价格形成的路径——
//    本文件对 Asset 的唯一写入是 ensureScenarioAssets 的 upsert, 且 update 恒为空对象
//    (存在即不动; lastPrice 是模拟盘自己的市场状态), create 里的初始价是一次性披露值
//    (见 description 措辞), 此后与真实行情无任何同步。
// 2. 情景标的 anchorPrice=null: bot 的 nextFair 在 anchor==last 时回归项为 0,
//    退化为围绕自身最新价的纯随机游走——做市不锚定任何外部价格。
// 3. ShadowSnapshot.realClose 仅内部研究用, 任何 API 路由不得 select/返回本表;
//    UI 不展示真实价、不展示偏离度(可反推)。
//
// ===== 行情采集提醒 =====
// - CEA 只走 overview.cneeex.com 子域(**不请求 www.cneeex.com**: WAF 420 + 站点条款限制);
//   CCER 走 ccer.com.cn 的隐性 JSON。每源每轮 ≤2 请求, 固定浏览器 UA, 30s 超时。
// - 采集失败只告警不抛——真实价缺失不算任务失败(近 7 日窗口内下轮补采)。
//
// 影子收盘/成交量只算撮合成交(OTC 会动 lastPrice 但不进 Trade 表, 分析时知情)。

const CNEEEX_ORIGIN = "https://overview.cneeex.com";
const CCER_JSON_URL = "https://www.ccer.com.cn/wcm/ccer/data/90-first.json";
/** 真实收盘补采回看窗口(日); 超窗仍为 null 的行永久保持 null(源已翻页/周末无公告属常态) */
const REAL_LOOKBACK_DAYS = 7;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface ScenarioAssetDef {
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  initPriceCents: number;
  description: string;
}

export const SCENARIO_ASSETS: readonly ScenarioAssetDef[] = [
  {
    symbol: "CEA-SCEN-2026",
    standard: "CEA",
    name: "全国碳市场配额情景(CEA)",
    projectType: "配额情景",
    vintage: 2026,
    country: "中国",
    registry: "情景标的(无真实登记)",
    initPriceCents: 9000,
    description:
      "中国全国碳市场配额(CEA)情景市场。初始价 $90.00(模拟盘统一以美元计价,数量级参考 2026-07 公开市场水平);此后价格完全由本模拟盘交易形成,不锚定、不同步任何真实行情。",
  },
  {
    symbol: "CCER-SCEN-2026",
    standard: "CCER",
    name: "CCER 市场指数情景",
    projectType: "配额情景",
    vintage: 2026,
    country: "中国",
    registry: "情景标的(无真实登记)",
    initPriceCents: 9000,
    description:
      "中国核证自愿减排量(CCER)市场指数情景。初始价 $90.00(模拟盘统一以美元计价,数量级参考 2026-07 公开市场水平);此后价格完全由本模拟盘交易形成,不锚定、不同步任何真实行情。",
  },
] as const;

// ===== 纯函数(单测覆盖, 夹具取自 2026-07-20 真实抓取样本) =====

const CST_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 毫秒时间戳 → Asia/Shanghai 的 "YYYY-MM-DD"(en-CA locale 恰为 ISO 日期格式) */
export function cstDayOf(ms: number): string {
  return CST_DAY_FMT.format(new Date(ms));
}

/** CST 日界的 UTC 毫秒区间 [当日0点, 次日0点); 中国无夏令时, 固定 UTC+8 */
export function cstDayRangeUtcMs(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00+08:00`);
  return { start, end: start + 86_400_000 };
}

/** "1,234.56" → 123456 分; 非法/非正数返回 null */
function centsOf(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * 列表页 href → overview 子域绝对 URL; 不合规返回 null。
 * 域名过滤(按采集提醒不请求 www.cneeex.com): 只放行站内相对路径与 overview 子域绝对地址,
 * 绝对 www/外域/协议相对/相似域名前缀一律丢弃——即使站方改版把公告链接改成绝对 www
 * 地址或页面被注入恶意链接, backfill 也不可能向 overview 之外的主机发请求。
 */
function resolveCneeexUrl(href: string): string | null {
  if (href.startsWith("//")) return null; // 协议相对: 主机取自 href, 拒绝
  if (href.startsWith("/")) return `${CNEEEX_ORIGIN}${href}`;
  // 必须带尾随 "/" 前缀匹配, 防 "https://overview.cneeex.com.evil.example" 这类相似域名
  return href.startsWith(`${CNEEEX_ORIGIN}/`) ? href : null;
}

/**
 * 列表页 → CEA 每日公告条目(新在前)。标题 `【CEA】…YYYYMMDD`;
 * 同一公告有 hidden-xs/hidden-lg 两个响应式 <li>, 按日期去重。
 * URL 经 resolveCneeexUrl 域名过滤, 不合规条目直接丢弃(不占用该日去重名额)。
 */
export function parseCneeexList(html: string): { date: string; url: string }[] {
  const out: { date: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\s+href="([^"]+\.shtml)"[^>]*>【CEA】[^<]*?(\d{8})\s*<\/a>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const url = resolveCneeexUrl(m[1]);
    if (url == null) continue;
    const d = m[2];
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, url });
  }
  return out;
}

/**
 * 文章页正文 → 收盘价(分)。正文形如 "…收盘价59.90元/吨，收盘价较前一日上涨0.25%。",
 * 以 "元/吨" 后缀锚定, 不会误抓涨跌幅; 先剥标签防数字被行内标签打断。抽不到返回 null 勿抛。
 */
export function parseCneeexArticle(html: string): { closeCents: number } | null {
  const text = html.replace(/<[^>]+>/g, "");
  const m = /收盘价\s*([\d,]+(?:\.\d+)?)\s*元\/吨/.exec(text);
  if (!m) return null;
  const closeCents = centsOf(m[1]);
  return closeCents == null ? null : { closeCents };
}

interface CcerRawRow {
  business_amount?: unknown;
  business_ave_price?: unknown;
  business_price?: unknown;
  business_date?: unknown;
  profession_name?: unknown;
}

/**
 * 90-first.json → day("YYYY-MM-DD") → 当日小计均价(分)。
 * 真实结构(2026-07-20 实测): 外层数组按日倒序, 每日一个内层数组(能源/林业/小计三行),
 * 字段全是字符串, 无值为 "-"。实测 61/61 天小计行 business_ave_price 为 "-",
 * 均价由 小计成交额/小计成交量(即全市场量加权均价)推导; 若源某日直接给数值则优先采用。
 * 非数组(加速乐挑战页/异常响应)返回空 Map 勿抛。
 */
export function parseCcerJson(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  const rows: CcerRawRow[] = raw.flatMap((el) =>
    Array.isArray(el) ? el : typeof el === "object" && el !== null ? [el] : []
  );
  for (const row of rows) {
    if (row.profession_name !== "小计") continue;
    const d = typeof row.business_date === "string" ? row.business_date : "";
    if (!/^\d{8}$/.test(d)) continue;
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const ave = centsOf(typeof row.business_ave_price === "string" ? row.business_ave_price : null);
    let cents = ave;
    if (cents == null) {
      const amount = Number(String(row.business_amount ?? "").replace(/,/g, ""));
      const turnover = Number(String(row.business_price ?? "").replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0 && Number.isFinite(turnover) && turnover > 0) {
        cents = Math.round((turnover / amount) * 100);
      }
    }
    if (cents != null && !out.has(day)) out.set(day, cents);
  }
  return out;
}

// ===== 落库任务 =====

/**
 * 情景标的幂等 ensure。update 必须为空对象——已存在则一个字段都不动:
 * lastPrice/orderbook 是模拟盘自己的市场状态, 任何"刷新"都构成外部价格注入(诚实性铁律)。
 */
export async function ensureScenarioAssets(): Promise<void> {
  const { prisma } = await import("../server/db");
  for (const a of SCENARIO_ASSETS) {
    await prisma.asset.upsert({
      where: { symbol: a.symbol },
      create: {
        symbol: a.symbol,
        name: a.name,
        standard: a.standard,
        projectType: a.projectType,
        vintage: a.vintage,
        country: a.country,
        registry: a.registry,
        description: a.description,
        lastPrice: a.initPriceCents,
        anchorPrice: null, // 关键: 不锚定 → bot 纯随机游走
        isScenario: true,
      },
      update: {},
    });
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`shadowprice HTTP ${res.status}: ${url}`);
  return res.text();
}

type PrismaDb = (typeof import("../server/db"))["prisma"];

/**
 * 近 7 日内 realClose 为 null 的快照行补采真实收盘。
 * CEA: 列表页 1 请求 + 文章页 ≤1 请求(每轮只补最新一天, 日频任务自然逐日跟上);
 * CCER: JSON 1 请求覆盖全部待补日。无待补行时零请求。失败只告警。
 */
async function backfillRealCloses(prisma: PrismaDb): Promise<void> {
  const minDay = cstDayOf(Date.now() - REAL_LOOKBACK_DAYS * 86_400_000);
  const pending = await prisma.shadowSnapshot.findMany({
    where: { realClose: null, day: { gte: minDay } },
    orderBy: { day: "desc" },
    select: { id: true, assetSymbol: true, day: true },
  });

  const ceaPending = pending.filter((p) => p.assetSymbol === "CEA-SCEN-2026");
  if (ceaPending.length > 0) {
    try {
      // 年份目录取最新待补日所在年(跨年首日列表切到新年目录, 旧年残留待补随窗口过期)
      const year = ceaPending[0].day.slice(0, 4);
      const list = parseCneeexList(await fetchText(`${CNEEEX_ORIGIN}/qgtpfqjy/mrgk/${year}n/`));
      const byDate = new Map(list.map((e) => [e.date, e.url]));
      const target = ceaPending.find((p) => byDate.has(p.day));
      if (target) {
        const parsed = parseCneeexArticle(await fetchText(byDate.get(target.day)!));
        if (parsed) {
          await prisma.shadowSnapshot.update({
            where: { id: target.id },
            data: { realClose: parsed.closeCents },
          });
          console.log(`[sync] shadowprice: CEA ${target.day} 真实收盘已补采`);
        }
      }
    } catch (e) {
      console.warn("[sync] shadowprice: CEA 真实收盘采集失败, 下轮再试", e);
    }
  }

  const ccerPending = pending.filter((p) => p.assetSymbol === "CCER-SCEN-2026");
  if (ccerPending.length > 0) {
    try {
      let json: unknown = null;
      try {
        json = JSON.parse(await fetchText(CCER_JSON_URL));
      } catch {
        // 非 JSON(挑战页等) → parseCcerJson 收到 null 返回空 Map
      }
      const byDay = parseCcerJson(json);
      for (const p of ccerPending) {
        const cents = byDay.get(p.day);
        if (cents == null) continue;
        await prisma.shadowSnapshot.update({ where: { id: p.id }, data: { realClose: cents } });
        console.log(`[sync] shadowprice: CCER ${p.day} 真实均价已补采`);
      }
    } catch (e) {
      console.warn("[sync] shadowprice: CCER 真实均价采集失败, 下轮再试", e);
    }
  }
}

/**
 * 每日任务(real-sync 循环调度, 24h 判据落 SyncRun):
 * ① ensure 情景标的; ② upsert 昨日(Asia/Shanghai 日界)影子收盘/量; ③ 补采真实收盘(内部对照)。
 */
export async function syncShadow(): Promise<{ rows: number }> {
  const { prisma } = await import("../server/db"); // 延迟加载: 测试只用纯函数, 不拉起数据库客户端
  const run = await prisma.syncRun.create({ data: { source: "shadowprice" } });
  try {
    await ensureScenarioAssets();

    const yesterday = cstDayOf(Date.now() - 86_400_000); // 中国无夏令时, 减一天毫秒即 CST 昨日
    const { start, end } = cstDayRangeUtcMs(yesterday);
    const window = { gte: new Date(start), lt: new Date(end) };
    let rows = 0;
    for (const s of SCENARIO_ASSETS) {
      const asset = await prisma.asset.findUnique({
        where: { symbol: s.symbol },
        select: { id: true },
      });
      if (!asset) continue;
      const [lastTrade, agg] = await Promise.all([
        prisma.trade.findFirst({
          where: { assetId: asset.id, createdAt: window },
          orderBy: { createdAt: "desc" },
          select: { price: true },
        }),
        prisma.trade.aggregate({
          where: { assetId: asset.id, createdAt: window },
          _sum: { quantity: true },
        }),
      ]);
      const shadowClose = lastTrade?.price ?? null;
      const shadowVolume = agg._sum.quantity ?? 0;
      await prisma.shadowSnapshot.upsert({
        where: { assetSymbol_day: { assetSymbol: s.symbol, day: yesterday } },
        create: { assetSymbol: s.symbol, day: yesterday, shadowClose, shadowVolume },
        update: { shadowClose, shadowVolume }, // 重跑只刷新影子侧, 不碰 realClose
      });
      rows++;
    }

    await backfillRealCloses(prisma);

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "OK", finishedAt: new Date(), rowsUpserted: rows },
    });
    console.log(`[sync] shadowprice: 完成, 快照 ${rows} 行(day=${yesterday})`);
    return { rows };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[sync] shadowprice: 失败", error);
    await prisma.syncRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error } })
      .catch(() => {});
    throw e;
  }
}
