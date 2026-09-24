import { describe, expect, it } from "vitest";
import {
  cstDayOf,
  cstDayRangeUtcMs,
  parseCcerJson,
  parseCneeexArticle,
  parseCneeexList,
  SCENARIO_ASSETS,
} from "./shadow";

// ===== 夹具全部节选自 2026-07-20 真实抓取样本(scratchpad: l26.html / cea.html / ccer-90-first.json) =====

// 列表页节选: 每个公告有 hidden-xs / hidden-lg 两个响应式 <li>(同链接重复), 另混入非 CEA 链接;
// 末尾追加一条绝对 www 地址的 CEA 公告(真实 l26.html 今天就含多条绝对 www 链接)——按采集提醒应被排除
const CEA_LIST_HTML = `
<ul class="list-unstyled articel-list">
    <li class="text-ellipsis  hidden-xs"><span class="pull-right m-l-sm">2026-07-17</span><a href="/c/2026-07-17/498006.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260717</a></li>
    <li class="hidden-lg hidden-sm hidden-md"><a href="/c/2026-07-17/498006.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260717</a> <span style="float:right;">2026-07-17</span></li>
    <li class="text-ellipsis  hidden-xs"><span class="pull-right m-l-sm">2026-07-16</span><a href="/c/2026-07-16/498004.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260716</a></li>
    <li class="hidden-lg hidden-sm hidden-md"><a href="/c/2026-07-16/498004.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260716</a> <span style="float:right;">2026-07-16</span></li>
    <li class="text-ellipsis  hidden-xs"><span class="pull-right m-l-sm">2026-07-15</span><a href="/c/2026-07-15/497930.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260715</a></li>
    <li class="hidden-lg hidden-sm hidden-md"><a href="/c/2026-07-15/497930.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260715</a> <span style="float:right;">2026-07-15</span></li>
    <li class="text-ellipsis  hidden-xs"><span class="pull-right m-l-sm">2026-07-14</span><a href="https://www.cneeex.com/c/2026-07-14/497871.shtml" target="_blank">【CEA】全国碳市场每日综合价格行情及成交信息20260714</a></li>
</ul>
<dt><a href="/c/2025-02-19/488525.shtml">基本信息</a></dt>
`;

// 文章页节选(2025-12-03 公告原文, 收盘价 59.90 元/吨; 注意"收盘价较前一日上涨0.25%"是干扰项)
const CEA_ARTICLE_HTML = `<p style="font-family: 宋体; font-size: 16px; text-indent: 2em;"><span style="color: #000000;">今日全国碳市场综合价格行情为: 开盘价59.66元/吨，最高价60.13元/吨，最低价59.56元/吨，收盘价59.90元/吨，收盘价较前一日上涨0.25%。</span><br/></p><p><span style="color: #000000;">今日挂牌协议交易成交量639,256吨，成交额38,268,042.10元；大宗协议交易成交量226,790吨，成交额12,472,500.00元；今日无单向竞价。</span></p>`;

// 90-first.json 前两个日组逐字节选: 外层数组按日倒序, 每日一个内层数组(能源/林业/小计三行),
// 全部字段是字符串, 无值为 "-"; 实测 61/61 天 小计行的 business_ave_price 均为 "-",
// 小计均价只能由 成交额/成交量 推导(89.91 与能源行均价一致, 因林业当日无成交)。
const CCER_JSON: unknown = [
  [
    { business_amount: "40610", business_ave_price: "89.91", business_price: "3651290.00", business_date: "20260717", profession_name: "能源产业(可再生/不可再生资源)" },
    { business_amount: "-", business_ave_price: "-", business_price: "-", business_date: "20260717", profession_name: "林业和其他碳汇类型" },
    { business_amount: "40610", business_ave_price: "-", business_price: "3651290.00", business_date: "20260717", profession_name: "小计" },
  ],
  [
    { business_amount: "336016", business_ave_price: "83.61", business_price: "28092920.00", business_date: "20260716", profession_name: "能源产业(可再生/不可再生资源)" },
    { business_amount: "-", business_ave_price: "-", business_price: "-", business_date: "20260716", profession_name: "林业和其他碳汇类型" },
    { business_amount: "336016", business_ave_price: "-", business_price: "28092920.00", business_date: "20260716", profession_name: "小计" },
  ],
];

describe("cstDayOf", () => {
  it("UTC 傍晚 16:00 即北京时间次日零点(跨午夜)", () => {
    expect(cstDayOf(Date.UTC(2026, 6, 19, 15, 59, 59))).toBe("2026-07-19");
    expect(cstDayOf(Date.UTC(2026, 6, 19, 16, 0, 0))).toBe("2026-07-20");
  });

  it("跨年: UTC 12-31 16:00 已是北京时间元旦", () => {
    expect(cstDayOf(Date.UTC(2025, 11, 31, 15, 59, 0))).toBe("2025-12-31");
    expect(cstDayOf(Date.UTC(2025, 11, 31, 16, 0, 0))).toBe("2026-01-01");
  });

  it("UTC 正午取当日(北京时间 20:00)", () => {
    expect(cstDayOf(Date.UTC(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
  });
});

describe("cstDayRangeUtcMs", () => {
  it("区间即该 CST 日的 UTC 毫秒 [0点, 次日0点)", () => {
    const { start, end } = cstDayRangeUtcMs("2026-07-20");
    expect(start).toBe(Date.UTC(2026, 6, 19, 16, 0, 0));
    expect(end - start).toBe(86_400_000);
  });

  it("与 cstDayOf 往返一致(含边界)", () => {
    const { start, end } = cstDayRangeUtcMs("2026-01-01");
    expect(cstDayOf(start)).toBe("2026-01-01");
    expect(cstDayOf(start - 1)).toBe("2025-12-31");
    expect(cstDayOf(end - 1)).toBe("2026-01-01");
    expect(cstDayOf(end)).toBe("2026-01-02");
  });
});

describe("parseCneeexList", () => {
  const entries = parseCneeexList(CEA_LIST_HTML);

  it("响应式重复 <li> 去重后每日一条, 按页面顺序(新在前)", () => {
    expect(entries.map((e) => e.date)).toEqual(["2026-07-17", "2026-07-16", "2026-07-15"]);
  });

  it("URL 补全为 overview 子域绝对地址", () => {
    expect(entries[0].url).toBe("https://overview.cneeex.com/c/2026-07-17/498006.shtml");
  });

  it("非 CEA 公告链接不混入", () => {
    expect(entries.some((e) => e.url.includes("488525"))).toBe(false);
  });

  it("无匹配时返回空数组", () => {
    expect(parseCneeexList("<html><body>页面维护中</body></html>")).toEqual([]);
  });

  it("绝对 www 链接被排除, 所有产出 URL 均在 overview 子域(不请求 www 子域)", () => {
    expect(entries.some((e) => e.date === "2026-07-14")).toBe(false);
    expect(entries.every((e) => e.url.startsWith("https://overview.cneeex.com/"))).toBe(true);
  });

  it("绝对 overview 子域链接放行; 协议相对与相似域名前缀丢弃", () => {
    const html = `
      <li><a href="https://overview.cneeex.com/c/2026-07-13/497800.shtml">【CEA】全国碳市场每日综合价格行情及成交信息20260713</a></li>
      <li><a href="//www.cneeex.com/c/2026-07-12/497700.shtml">【CEA】全国碳市场每日综合价格行情及成交信息20260712</a></li>
      <li><a href="https://overview.cneeex.com.evil.example/c/2026-07-11/497600.shtml">【CEA】全国碳市场每日综合价格行情及成交信息20260711</a></li>`;
    expect(parseCneeexList(html)).toEqual([
      { date: "2026-07-13", url: "https://overview.cneeex.com/c/2026-07-13/497800.shtml" },
    ]);
  });

  it("不合规链接不占用该日去重名额: 同日靠后的合规条目仍被收录", () => {
    const html = `
      <li><a href="https://www.cneeex.com/c/2026-07-10/497500.shtml">【CEA】全国碳市场每日综合价格行情及成交信息20260710</a></li>
      <li><a href="/c/2026-07-10/497500.shtml">【CEA】全国碳市场每日综合价格行情及成交信息20260710</a></li>`;
    expect(parseCneeexList(html)).toEqual([
      { date: "2026-07-10", url: "https://overview.cneeex.com/c/2026-07-10/497500.shtml" },
    ]);
  });
});

describe("parseCneeexArticle", () => {
  it("从正文抽收盘价并转分(不误抓开盘/最高/最低与涨跌幅)", () => {
    expect(parseCneeexArticle(CEA_ARTICLE_HTML)).toEqual({ closeCents: 5990 });
  });

  it("千分位容错", () => {
    expect(parseCneeexArticle("<p>收盘价1,234.56元/吨</p>")).toEqual({ closeCents: 123456 });
  });

  it("正文无收盘价返回 null 不抛", () => {
    expect(parseCneeexArticle("<p>今日无成交。</p>")).toBeNull();
    expect(parseCneeexArticle("")).toBeNull();
  });
});

describe("parseCcerJson", () => {
  it("真实结构: 小计行均价为 '-', 由 成交额/成交量 推导(分)", () => {
    const m = parseCcerJson(CCER_JSON);
    expect(m.get("2026-07-17")).toBe(8991); // 3651290.00 / 40610 = 89.9111 → 8991 分
    expect(m.get("2026-07-16")).toBe(8361); // 28092920.00 / 336016 = 83.6059 → 8361 分
    expect(m.size).toBe(2);
  });

  it("两行业均有成交时推导的是量加权均价", () => {
    const m = parseCcerJson([
      [
        { business_amount: "100", business_ave_price: "90", business_price: "9000", business_date: "20260701", profession_name: "能源产业(可再生/不可再生资源)" },
        { business_amount: "100", business_ave_price: "80", business_price: "8000", business_date: "20260701", profession_name: "林业和其他碳汇类型" },
        { business_amount: "200", business_ave_price: "-", business_price: "17000", business_date: "20260701", profession_name: "小计" },
      ],
    ]);
    expect(m.get("2026-07-01")).toBe(8500);
  });

  it("小计行若直接给出数值均价则优先采用", () => {
    const m = parseCcerJson([
      [{ business_amount: "200", business_ave_price: "85.5", business_price: "17000", business_date: "20260701", profession_name: "小计" }],
    ]);
    expect(m.get("2026-07-01")).toBe(8550);
  });

  it("小计全为 '-'(当日无成交)则跳过该日", () => {
    const m = parseCcerJson([
      [{ business_amount: "-", business_ave_price: "-", business_price: "-", business_date: "20260702", profession_name: "小计" }],
    ]);
    expect(m.size).toBe(0);
  });

  it("非数组(加速乐挑战页/异常响应)返回空 Map", () => {
    expect(parseCcerJson("<html>challenge</html>").size).toBe(0);
    expect(parseCcerJson({ error: 1 }).size).toBe(0);
    expect(parseCcerJson(null).size).toBe(0);
    expect(parseCcerJson(undefined).size).toBe(0);
  });

  it("防御: 扁平行数组(无日分组)也能解析", () => {
    const m = parseCcerJson([
      { business_amount: "10", business_ave_price: "88", business_price: "880", business_date: "20260703", profession_name: "小计" },
    ]);
    expect(m.get("2026-07-03")).toBe(8800);
  });
});

describe("SCENARIO_ASSETS", () => {
  it("两个情景标的: symbol 固定, 初始价 $90.00, 披露措辞在 description", () => {
    expect(SCENARIO_ASSETS.map((a) => a.symbol)).toEqual(["CEA-SCEN-2026", "CCER-SCEN-2026"]);
    for (const a of SCENARIO_ASSETS) {
      expect(a.initPriceCents).toBe(9000);
      // 币种符号必须与全站展示层一致(统一 $), 不得出现 ¥(2026-07-24: 描述里 ¥90.00 与页面 $ 不一致)
      expect(a.description).toContain("$90.00");
      expect(a.description).not.toContain("¥");
      expect(a.description).toContain("参考 2026-07 公开市场水平");
      expect(a.description).toContain("完全由本模拟盘交易形成");
    }
  });
});
