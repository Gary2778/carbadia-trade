// CSV 序列化(计划 §6.2.2 C5、§9.2 D28):纯函数,服务端的三个导出接口按页调用。
//   - RFC 4180:单元格含逗号、双引号、回车或换行时用双引号包起来,内部的双引号写两遍;行尾 CRLF。
//   - 公式注入:**文本**单元格以 = + - @、制表符或回车开头时前置一个单引号(表格软件不会把它当公式执行)。
//     数值单元格(列的 type 由调用方标明)不前置——负数 "-285.00" 要保持是个数;但只有长得像十进制数的内容才按数值放行,
//     标成数值、内容却不是数的(调用方标错了类型)仍按文本处理。
//   - 没有说明行(D28):文件第一行就是表头,「这是模拟数据」由文件名与每行末列 environment 表达。

/** UTF-8 BOM:放在文件最前面,Excel 才会按 UTF-8 打开(否则中文会乱码) */
export const CSV_BOM = "\uFEFF";
const CRLF = "\r\n";

export type CsvCellType = "text" | "number";
export type CsvValue = string | number | null | undefined;
/** 一列:表头名、单元格类型(决定要不要做公式防护)、取值 */
export type CsvColumn<Row> = { name: string; type: CsvCellType; value: (row: Row) => CsvValue };

/** 表格软件会把这些字符开头的单元格当公式(或 DDE)解析 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** 可选负号、整数部分、可选小数部分;不含指数、千分位、空白 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

/** 一个单元格;null / undefined → 空 */
export function csvCell(value: CsvValue, type: CsvCellType): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (type === "number" && PLAIN_NUMBER.test(text)) return text;
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 一行数据(含行尾 CRLF) */
export function toCsvRow<Row>(columns: readonly CsvColumn<Row>[], row: Row): string {
  return columns.map((column) => csvCell(column.value(row), column.type)).join(",") + CRLF;
}

/** 表头行(含行尾 CRLF) */
export function csvHeader<Row>(columns: readonly CsvColumn<Row>[]): string {
  return columns.map((column) => csvCell(column.name, "text")).join(",") + CRLF;
}

/** 整份文件:BOM + 表头 + 各行。流式导出不用它(按页调 toCsvRow),这里给小数据与测试用 */
export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  return CSV_BOM + csvHeader(columns) + rows.map((row) => toCsvRow(columns, row)).join("");
}

/**
 * 整数分 → 两位小数的十进制字符串("-285.00"),不带千分位。只做整数运算:先取余、再除以整百,不经过浮点小数。
 * null / undefined → null(单元格留空:未知的均价不写成 0.00)。不是安全整数就抛 RangeError(分不会是小数,不猜)。
 */
export function centsToDecimal(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  if (!Number.isSafeInteger(cents)) throw new RangeError(`centsToDecimal: not a safe integer (${cents})`);
  const abs = Math.abs(cents);
  const fraction = abs % 100;
  const whole = (abs - fraction) / 100;
  return `${cents < 0 ? "-" : ""}${whole}.${fraction < 10 ? "0" : ""}${fraction}`;
}

/** unix 毫秒 → ISO 8601 UTC(2026-10-01T08:05:09.007Z) */
export const isoTime = (ms: number): string => new Date(ms).toISOString();
