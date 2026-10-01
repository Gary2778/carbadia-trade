// CSV 导出(计划 §6.2.2 C5、§9.2 D28):订单、成交、流水三个接口的共同部分与各自的列。
// 路由文件(src/app/api/account/orders.csv、fills.csv、src/app/api/transactions.csv)只有一行转调:
// Next 的 route.ts 只能导出 HTTP 方法与路由配置,行数上限这类可注入的参数放不进去,所以处理函数在这里(测试直接传小的上限)。
//
//   - 数据一页页取,用的是 JSON 接口的同一个读取函数(account-pages.ts、ledger-activity-page.ts)与同一组筛选参数,
//     键集游标 createdAt desc, id desc;导出开始之后才写入的行比游标新,不会进文件。
//   - SQLite 只有一个连接(db.ts):不开长事务,每页之间把事件循环让出来一轮,别的请求排着队的查询先走。
//   - 第一页在返回响应之前读:查询一开始就失败时还能回一个正常的 500,而不是一个只有表头的文件。
//   - 流已经开始之后再出错:已发出的字节收不回来,流以错误结束(连接被掐断,浏览器把下载标成失败),并记一行日志。
//     不「正常收尾」——那样用户拿到的是一个看起来完整、其实被截断的文件。
//   - 到行数上限即停并记日志(文件在上限处结束,是完整的 CSV)。
//   - 客户端断开(流被 cancel,或请求的 signal 中止)后不再读库。
import { BASE_UNIT } from "@/shared/constants";
import { centsToDecimal, CSV_BOM, csvHeader, isoTime, toCsvRow, type CsvColumn } from "@/shared/csv";
import type { LedgerActivity } from "@/shared/api-shapes";
import type { Fill, Order } from "@/shared/types";
import { readFillsPage, readOrderFilters, readOrdersPage } from "./account-pages";
import { fail, handle } from "./api";
import { requireUser } from "./auth";
import { decodeCursor, type Cursor } from "./cursor";
import { readLedgerActivityPage, readLedgerFilters } from "./ledger-activity-page";
import { rateLimit, retryAfterSeconds } from "./rate-limit";

export type CsvKind = "orders" | "fills" | "ledger";

/** 单次导出最多这么多行数据(不含表头) */
export const CSV_MAX_ROWS = 100_000;
/** 每次读库的行数。比 JSON 接口的页(≤ 100)大:同样的行数少几轮查询;再大则单次查询占着唯一的连接太久 */
export const CSV_PAGE_ROWS = 200;
/**
 * 订单导出的每页行数(P2-13,终审 P2-SRV-3):Order 没有 (userId, createdAt) 索引(Phase 2 不改库),每一页都要把该用户的
 * 全部订单读出来排序,成本与页数成正比、与页大小关系不大;页放大 10 倍,整份导出的全量读少 10 倍。成交与流水的每页
 * 只读游标附近的行(account-pages.ts、ledger-activity-page.ts),仍按 CSV_PAGE_ROWS。索引留给下一个允许迁移的阶段(计划 §9.1)
 */
export const CSV_ORDER_PAGE_ROWS = 2_000;
/** 每个用户每分钟 10 次,三个导出接口共用一个桶(csv:user:<id>) */
export const CSV_RATE_LIMIT = 10;
export const CSV_RATE_WINDOW_MS = 60_000;

/** 测试用的注入点;生产路由不传(pageRows 不传时按导出种类取默认:订单 CSV_ORDER_PAGE_ROWS,其余 CSV_PAGE_ROWS) */
export type CsvExportOptions = { maxRows?: number; pageRows?: number; now?: number };

const PRIVATE = { "Cache-Control": "private, no-store" } as const;
/** 每行末列:这是模拟环境的数据(D28:不写说明行,改由文件名与这一列表达) */
const ENVIRONMENT = "SIMULATED";

/** carbadia-trade-simulated-<orders|fills|ledger>-<YYYYMMDD>.csv;日期取 UTC(文件里的时间也是 UTC) */
export function csvFilename(kind: CsvKind, now: number): string {
  return `carbadia-trade-simulated-${kind}-${isoTime(now).slice(0, 10).replace(/-/g, "")}.csv`;
}

export const ORDER_COLUMNS: readonly CsvColumn<Order>[] = [
  { name: "createdAt", type: "text", value: (o) => isoTime(o.createdAt) },
  { name: "updatedAt", type: "text", value: (o) => isoTime(o.updatedAt) },
  { name: "orderId", type: "text", value: (o) => o.id },
  { name: "clientOrderId", type: "text", value: (o) => o.clientOrderId },
  { name: "symbol", type: "text", value: (o) => o.symbol },
  { name: "side", type: "text", value: (o) => o.side },
  { name: "type", type: "text", value: (o) => o.type },
  // 市价单没有委托价、未成交的单没有均价:留空
  { name: "price", type: "number", value: (o) => centsToDecimal(o.price) },
  { name: "quantity", type: "number", value: (o) => o.quantity },
  { name: "filledQuantity", type: "number", value: (o) => o.filledQuantity },
  { name: "avgFillPrice", type: "number", value: (o) => centsToDecimal(o.avgFillPrice) },
  { name: "status", type: "text", value: (o) => o.status },
  { name: "cancelReason", type: "text", value: (o) => o.cancelReason },
  { name: "environment", type: "text", value: () => ENVIRONMENT },
];

export const FILL_COLUMNS: readonly CsvColumn<Fill>[] = [
  { name: "time", type: "text", value: (f) => isoTime(f.ts) },
  { name: "fillId", type: "text", value: (f) => f.id },
  { name: "orderId", type: "text", value: (f) => f.orderId },
  { name: "symbol", type: "text", value: (f) => f.symbol },
  { name: "side", type: "text", value: (f) => f.side },
  { name: "role", type: "text", value: (f) => f.role },
  { name: "price", type: "number", value: (f) => centsToDecimal(f.price) },
  { name: "quantity", type: "number", value: (f) => f.quantity },
  { name: "notional", type: "number", value: (f) => centsToDecimal(f.notional) },
  { name: "fee", type: "number", value: (f) => centsToDecimal(f.feeCents) },
  { name: "auditRef", type: "text", value: (f) => f.auditRef },
  { name: "environment", type: "text", value: () => ENVIRONMENT },
];

const isCashAccount = (entry: LedgerActivity): boolean => entry.account === "CASH" || entry.account === "CASH_LOCKED";

export const LEDGER_COLUMNS: readonly CsvColumn<LedgerActivity>[] = [
  { name: "time", type: "text", value: (e) => isoTime(e.ts) },
  { name: "id", type: "text", value: (e) => e.id },
  { name: "type", type: "text", value: (e) => e.type },
  { name: "account", type: "text", value: (e) => e.account },
  { name: "symbol", type: "text", value: (e) => e.symbol },
  // 现金账户的变动是整数分 → 两位小数;持仓账户是整数数量。带符号,是数值单元格(负数不加公式防护的单引号)
  { name: "delta", type: "number", value: (e) => (isCashAccount(e) ? centsToDecimal(e.delta) : e.delta) },
  // 先看账户再看 isScenario:情景标的成交的现金腿仍是现金;只有持仓账户上的情景标的写「scenario unit」(不是碳信用,不写吨)
  { name: "unit", type: "text", value: (e) => (isCashAccount(e) ? "USD" : e.isScenario ? "scenario unit" : BASE_UNIT) },
  { name: "reason", type: "text", value: (e) => e.reason },
  { name: "refType", type: "text", value: (e) => e.refType },
  { name: "refId", type: "text", value: (e) => e.refId },
  { name: "environment", type: "text", value: () => ENVIRONMENT },
];

type CsvPage<Row> = { rows: Row[]; next: Cursor | null };
type PageReader<Row> = (cursor: Cursor | null, limit: number) => Promise<CsvPage<Row>>;

/** 把事件循环让出一轮(宏任务):别的请求的处理函数得以运行,它们的查询排在本导出的下一页之前 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

type StreamInput<Row> = {
  kind: CsvKind; userId: string; columns: readonly CsvColumn<Row>[]; readPage: PageReader<Row>; first: CsvPage<Row>;
  maxRows: number; pageRows: number; signal: AbortSignal | undefined;
};

/**
 * 导出的响应体:BOM + 表头 + 第一页在 start 里入队,之后每次 pull 读一页(消费者读得慢,读库也跟着慢)。
 * 见文件头关于让出、出错、行数上限与客户端断开的说明。
 */
function csvStream<Row>({ kind, userId, columns, readPage, first, maxRows, pageRows, signal }: StreamInput<Row>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encodeRows = (rows: readonly Row[]) => encoder.encode(rows.map((row) => toCsvRow(columns, row)).join(""));
  let cursor = first.next;
  let written = first.rows.length;
  let stopped = false;
  const stop = () => { stopped = true; };
  signal?.addEventListener("abort", stop, { once: true });
  /** 已停(客户端断开)时把流收掉;流若已被 cancel,close 会抛,吞掉即可 */
  const closeQuietly = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close();
    } catch {
      // 已经关闭或已被取消
    }
  };

  /** 还有没有下一页要读;到上限而后面还有行时记一行日志 */
  const finished = (): boolean => {
    if (!cursor) return true;
    if (written < maxRows) return false;
    console.warn(`[csv] ${kind} export for user ${userId} stopped at the row limit (${maxRows} rows); older rows were left out`);
    return true;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_BOM + csvHeader(columns)));
      if (first.rows.length > 0) controller.enqueue(encodeRows(first.rows));
      if (finished()) controller.close();
    },
    async pull(controller) {
      try {
        await yieldToEventLoop();
        if (stopped) return closeQuietly(controller);
        const page = await readPage(cursor, Math.min(pageRows, maxRows - written));
        if (stopped) return closeQuietly(controller);
        cursor = page.rows.length > 0 ? page.next : null; // 空页即到底(读取函数不会给出「空页但还有下一页」,这里只是不让流悬着)
        written += page.rows.length;
        if (page.rows.length > 0) controller.enqueue(encodeRows(page.rows));
        if (finished()) controller.close();
      } catch (err) {
        if (stopped) return closeQuietly(controller); // 客户端已经走了:这一页读失败无关紧要
        stopped = true;
        console.error(`[csv] ${kind} export for user ${userId} failed after ${written} rows; the download was aborted`, err);
        controller.error(err);
      }
    },
    cancel() {
      stop();
    },
  });
}

/**
 * 三个导出接口的共同流程:登录 → 限流 → 读筛选(非法 400)→ 读第一页 → 流式响应。
 * 失败的响应(401 / 429 / 400 / 500)仍是 JSON 信封,带 private, no-store。
 * prepare 拿到查询参数与用户 id,返回读一页的函数,或 { error }。查询参数里的 cursor / limit 不读(导出总是从头到尾)。
 */
async function exportCsv<Row>(
  req: Request,
  kind: CsvKind,
  columns: readonly CsvColumn<Row>[],
  prepare: (params: URLSearchParams, userId: string) => PageReader<Row> | { error: string },
  options: CsvExportOptions,
  defaultPageRows: number = CSV_PAGE_ROWS,
): Promise<Response> {
  try {
    const user = await requireUser();
    const key = `csv:user:${user.id}`;
    if (!rateLimit(key, CSV_RATE_LIMIT, CSV_RATE_WINDOW_MS)) {
      return fail("Too many requests, please retry later", 429, { ...PRIVATE, "Retry-After": String(retryAfterSeconds(key, CSV_RATE_WINDOW_MS)) });
    }
    const readPage = prepare(new URL(req.url).searchParams, user.id);
    if (typeof readPage !== "function") return fail(readPage.error, 400, PRIVATE);

    const maxRows = Math.max(1, options.maxRows ?? CSV_MAX_ROWS);
    const pageRows = Math.max(1, options.pageRows ?? defaultPageRows);
    const first = await readPage(null, Math.min(pageRows, maxRows));
    const stream = csvStream({ kind, userId: user.id, columns, readPage, first, maxRows, pageRows, signal: req.signal });
    return new Response(stream, {
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(kind, options.now ?? Date.now())}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}

/** GET /api/account/orders.csv?status=open|history&symbol=;不给 status 导出全部状态 */
export function ordersCsvResponse(req: Request, options: CsvExportOptions = {}): Promise<Response> {
  return exportCsv(req, "orders", ORDER_COLUMNS, (params, userId) => {
    const filters = readOrderFilters(params);
    if ("error" in filters) return filters;
    return async (cursor, limit) => {
      const page = await readOrdersPage(userId, filters, { limit, cursor });
      return { rows: page.orders, next: page.next };
    };
  }, options, CSV_ORDER_PAGE_ROWS);
}

/** GET /api/account/fills.csv?symbol= */
export function fillsCsvResponse(req: Request, options: CsvExportOptions = {}): Promise<Response> {
  return exportCsv(req, "fills", FILL_COLUMNS, (params, userId) => {
    const filters = { symbol: params.get("symbol") || null };
    return async (cursor, limit) => {
      const page = await readFillsPage(userId, filters, { limit, cursor }, { ledgerRefs: false });
      return { rows: page.fills, next: page.next };
    };
  }, options);
}

/** GET /api/transactions.csv?account=&type=&symbol=&from=&to=(与 GET /api/transactions 同一组筛选,同样的 400) */
export function ledgerCsvResponse(req: Request, options: CsvExportOptions = {}): Promise<Response> {
  return exportCsv(req, "ledger", LEDGER_COLUMNS, (params, userId) => {
    const filters = readLedgerFilters(params);
    if ("error" in filters) return filters;
    return async (cursor, limit) => {
      const page = await readLedgerActivityPage(userId, filters, { limit, cursor });
      return { rows: page.items, next: page.nextCursor ? decodeCursor(page.nextCursor) : null };
    };
  }, options);
}
