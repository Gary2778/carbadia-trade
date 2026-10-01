// GET /api/account/fills.csv?symbol=(计划 §6.2.2 C5):本人成交的 CSV,流式;列含 auditRef 与末列 environment = SIMULATED。
// 筛选参数与 GET /api/account/fills 相同(不带 cursor / limit),行也相同——两边读的是 account-pages.ts 的同一个函数。
// 私有:requireUser、private, no-store、不进边缘名单;每用户 10 次 / 分钟(三个导出接口共用一个桶)。实现在 src/lib/server/csv-export.ts。
import { fillsCsvResponse } from "@/lib/server/csv-export";

export const GET = (req: Request) => fillsCsvResponse(req);
