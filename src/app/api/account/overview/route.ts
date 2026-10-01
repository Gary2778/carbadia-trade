// GET /api/account/overview(计划 §6.2.2 C6):资产页首屏要的全部数字 —— 余额、持仓(含整仓注销的行)、合计、24 小时变化、本人 ACTIVE 的场外挂牌;
// ?parts=extras 只给 24 小时变化与挂牌(资产页之后的重取用,不做成本回放;P2-13)。
// 读取、每用户限流(30 次 / 分钟,429 带 Retry-After)与同一用户并发请求共用一次读取都在 src/lib/server/account-overview.ts:
// route.ts 只能导出 HTTP 方法与路由配置,限流数值这类要给测试读的常量放在那边。
// 只读,不写库。响应含用户数据:private, no-store,路径不在边缘缓存名单里。
import { overviewResponse } from "@/lib/server/account-overview";

export function GET(req: Request): Promise<Response> {
  return overviewResponse(req);
}
