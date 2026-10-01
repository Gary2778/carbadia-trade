// GET /api/transactions.csv?account=&type=&symbol=&from=&to=(计划 §6.2.2 C5):本人账户流水的 CSV,流式。
// 筛选参数与 GET /api/transactions 相同(不带 cursor / limit),非法值同样 400;行也相同——两边读的是 ledger-activity-page.ts 的同一个函数。
// 私有:requireUser、private, no-store、不进边缘名单;每用户 10 次 / 分钟(三个导出接口共用一个桶)。实现在 src/lib/server/csv-export.ts。
import { ledgerCsvResponse } from "@/lib/server/csv-export";

export const GET = (req: Request) => ledgerCsvResponse(req);
