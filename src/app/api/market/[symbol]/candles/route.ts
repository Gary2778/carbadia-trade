import { ok, fail, handle } from "@/lib/server/api";
import { INTERVALS } from "@/lib/exchange/candles";
import { CANDLES_RATE_LIMIT, findAssetRef, getPublicBars, readMs } from "@/lib/server/market-snapshots";
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/server/rate-limit";
import { CANDLE_INTERVALS } from "@/shared/constants";
import type { CandlesResponse } from "@/shared/api-shapes";
import type { CandleInterval } from "@/shared/types";

// 公开 K 线(计划 §3.4 路由表):?interval=1m&limit=500&to=<unix ms>;interval 非法 → 400;limit 按周期钳到 PUBLIC_MAX_BARS
//(1m 1500 —— 分时请求 1440;5m / 15m / 1h 1000;4h / 1d 500,P1-25e 收紧);窗口恒为 limit × interval(SQLite 聚合),
// 不是旧端点的固定 lookback + 240 根。
// 放大防护(P1-25b / P1-25e):边缘缓存按整条 URL 做键,乱加参数就能绕过,所以源站自己兜底(getPublicBars)——
//   - 不带 to(客户端从不带)、to 在未来或落在当前桶 → 「到现在」的窗口;过去的 to 对齐到所在桶的末尾;两种都走 5 s 进程缓存,
//     limit 分两档查、按时间窗截取,乱写 limit / to 落不出无限多的缓存键,并发未命中只查一次库;
//   - 按 IP 限流 CANDLES_RATE_LIMIT(120/min),429 带 Retry-After(文案与全站其它 429 一致,见计划 §9.2 D14);
//   - 许多 IP 各带不同的过去 to 仍然每次未命中:过去的窗口未命中时查库再过一道全进程预算(BARS_QUERY_BUDGET),用完回 503 + Retry-After: 1;
//     「到现在」的窗口不花预算、不会 503(键空间有界),预算被抽干时终端的正常图表照常加载。
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=5, stale-while-revalidate=10" } };

const isInterval = (s: string): s is CandleInterval => Object.hasOwn(INTERVALS, s);

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const key = `candles:ip:${clientIp(req)}`;
    if (!rateLimit(key, CANDLES_RATE_LIMIT.limit, CANDLES_RATE_LIMIT.windowMs)) {
      return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, CANDLES_RATE_LIMIT.windowMs)) });
    }
    const { symbol } = await ctx.params;
    const query = new URL(req.url).searchParams;
    const interval = query.get("interval") ?? "1m";
    if (!isInterval(interval)) return fail(`interval must be one of ${CANDLE_INTERVALS.join("/")}`, 400);
    const asset = await findAssetRef(symbol);
    if (!asset) return fail("Instrument not found", 404);
    const bars = getPublicBars(asset, interval, query.get("limit"), readMs(query.get("to")));
    if (!bars) return fail("Busy, please retry later", 503, { "Retry-After": "1" });
    const data: CandlesResponse = { interval, candles: await bars };
    return ok(data, PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
