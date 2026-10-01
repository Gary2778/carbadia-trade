// CSV 纯函数(计划 §6.2.2 C5):RFC 4180 转义、公式注入防护(只对文本单元格)、BOM、空值、分 → 两位小数、ISO 时间。
import { describe, expect, it } from "vitest";
import { CSV_BOM, centsToDecimal, csvCell, csvHeader, isoTime, toCsv, toCsvRow, type CsvColumn } from "./csv";

describe("csvCell:RFC 4180 转义", () => {
  it("普通文本原样输出", () => {
    expect(csvCell("VCS-FOR-2021", "text")).toBe("VCS-FOR-2021");
    expect(csvCell("SIMULATED", "text")).toBe("SIMULATED");
    expect(csvCell("2026-10-01T08:00:00.000Z", "text")).toBe("2026-10-01T08:00:00.000Z");
  });

  it("含逗号、引号、换行的文本用双引号包起来,内部的引号写两遍", () => {
    expect(csvCell("a,b", "text")).toBe('"a,b"');
    expect(csvCell('say "hi"', "text")).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2", "text")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2", "text")).toBe('"line1\r\nline2"');
    expect(csvCell('a,"b"\nc', "text")).toBe('"a,""b""\nc"');
  });

  it("null / undefined / 空串输出空单元格(不是字面量 null)", () => {
    expect(csvCell(null, "text")).toBe("");
    expect(csvCell(undefined, "text")).toBe("");
    expect(csvCell("", "text")).toBe("");
    expect(csvCell(null, "number")).toBe("");
    expect(csvCell(undefined, "number")).toBe("");
  });
});

describe("csvCell:公式注入", () => {
  it("文本以 = + - @、制表符或回车开头时前置单引号", () => {
    expect(csvCell("=SUM(A1:A9)", "text")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1+1", "text")).toBe("'+1+1");
    expect(csvCell("-2+3", "text")).toBe("'-2+3");
    expect(csvCell("@SUM(1)", "text")).toBe("'@SUM(1)");
    expect(csvCell("\tcmd", "text")).toBe("'\tcmd");
    // 回车开头:前置之后还含回车,所以整格再加引号
    expect(csvCell("\rcmd", "text")).toBe("\"'\rcmd\"");
  });

  it("前置之后照常做 RFC 4180 转义", () => {
    expect(csvCell('=HYPERLINK("http://example.test","x")', "text")).toBe('"\'=HYPERLINK(""http://example.test"",""x"")"');
    expect(csvCell("=1,2", "text")).toBe("\"'=1,2\"");
  });

  it("危险字符不在开头的文本不动", () => {
    expect(csvCell("a=b", "text")).toBe("a=b");
    expect(csvCell("VCS-FOR-2021", "text")).toBe("VCS-FOR-2021");
    expect(csvCell("user@example.test", "text")).toBe("user@example.test");
  });

  it("数值单元格不前置:负数与带符号的小数原样输出", () => {
    expect(csvCell(-5, "number")).toBe("-5");
    expect(csvCell(0, "number")).toBe("0");
    expect(csvCell(42, "number")).toBe("42");
    expect(csvCell("-285.00", "number")).toBe("-285.00");
    expect(csvCell("0.00", "number")).toBe("0.00");
    expect(csvCell("1234567.89", "number")).toBe("1234567.89");
  });

  it("标成数值但长得不像数的内容按文本处理(调用方标错类型也不放过公式)", () => {
    expect(csvCell("=1+1", "number")).toBe("'=1+1");
    expect(csvCell("-1+cmd|' /C calc'!A0", "number")).toBe("'-1+cmd|' /C calc'!A0");
    expect(csvCell("1,5", "number")).toBe('"1,5"');
    expect(csvCell("1e5", "number")).toBe("1e5");
    expect(csvCell(Number.NaN, "number")).toBe("NaN");
    expect(csvCell(-Infinity, "number")).toBe("'-Infinity");
  });
});

type Row = { name: string | null; qty: number; amount: string | null };
const COLUMNS: readonly CsvColumn<Row>[] = [
  { name: "name", type: "text", value: (r) => r.name },
  { name: "qty", type: "number", value: (r) => r.qty },
  { name: "amount", type: "number", value: (r) => r.amount },
];

describe("toCsvRow / csvHeader / toCsv", () => {
  it("一行以 CRLF 结尾,单元格按列的类型处理", () => {
    expect(toCsvRow(COLUMNS, { name: "-minus", qty: -3, amount: "-1.50" })).toBe("'-minus,-3,-1.50\r\n");
    expect(toCsvRow(COLUMNS, { name: null, qty: 0, amount: null })).toBe(",0,\r\n");
  });

  it("表头取列名,同样转义", () => {
    expect(csvHeader(COLUMNS)).toBe("name,qty,amount\r\n");
    expect(csvHeader([{ name: "a,b", type: "text", value: () => "" }])).toBe('"a,b"\r\n');
  });

  it("整份文件 = BOM + 表头 + 各行;没有行时只有 BOM 与表头", () => {
    const csv = toCsv(COLUMNS, [
      { name: "plain", qty: 1, amount: "1.00" },
      { name: 'quo"te, and\nnewline', qty: 2, amount: null },
    ]);
    expect(csv).toBe('\uFEFFname,qty,amount\r\nplain,1,1.00\r\n"quo""te, and\nnewline",2,\r\n');
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(CSV_BOM).toBe("\uFEFF");
    expect(new TextEncoder().encode(CSV_BOM)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(toCsv(COLUMNS, [])).toBe("\uFEFFname,qty,amount\r\n");
  });
});

describe("centsToDecimal:分 → 两位小数(整数运算)", () => {
  it("补零、负号、零", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(50)).toBe("0.50");
    expect(centsToDecimal(100)).toBe("1.00");
    expect(centsToDecimal(28_500)).toBe("285.00");
    expect(centsToDecimal(-28_500)).toBe("-285.00");
    expect(centsToDecimal(-1)).toBe("-0.01");
    expect(centsToDecimal(-0)).toBe("0.00");
  });

  it("不带千分位,大数不丢精度(浮点除法会错的数)", () => {
    expect(centsToDecimal(123_456_789)).toBe("1234567.89");
    expect(centsToDecimal(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(centsToDecimal(-Number.MAX_SAFE_INTEGER)).toBe("-90071992547409.91");
    // 0.29 × 100 在浮点里是 28.999999999999996:从整数分出发就没有这个问题
    expect(centsToDecimal(29)).toBe("0.29");
    expect(centsToDecimal(1_005)).toBe("10.05");
  });

  it("null / undefined → null(单元格留空,不把未知写成 0.00)", () => {
    expect(centsToDecimal(null)).toBeNull();
    expect(centsToDecimal(undefined)).toBeNull();
  });

  it("不是安全整数就抛错(分不会是小数;不猜)", () => {
    expect(() => centsToDecimal(1.5)).toThrow(RangeError);
    expect(() => centsToDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => centsToDecimal(2 ** 53)).toThrow(RangeError);
  });
});

describe("isoTime", () => {
  it("unix 毫秒 → ISO 8601 UTC(带毫秒与 Z)", () => {
    expect(isoTime(Date.UTC(2026, 9, 1, 8, 5, 9, 7))).toBe("2026-10-01T08:05:09.007Z");
    expect(isoTime(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
