import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatTime, startOfDayMs, zoneLabel, zoneOffsetSeconds, type TimeStyle } from "./time-format";

// 显示时间的唯一入口(lib/time-format.ts)。「本地」用 process.env.TZ 钉成洛杉矶(有夏令时),不依赖运行机器的时区;
// 带夏令时的区另用函数自己的 zone 参数验证(传 IANA 区名,不靠机器的区)。
const LOCAL_ZONE = "America/Los_Angeles";
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = LOCAL_ZONE;
  // 前提:这个进程里真的换了时区,否则下面的「本地」断言什么也没验证
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(LOCAL_ZONE);
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

// 2026-10-02 05:04:22 UTC = 北京 13:04:22 = 洛杉矶(PDT)10-01 22:04:22:三个时区里日期与小时都不同
const AT = Date.UTC(2026, 9, 2, 5, 4, 22);

describe("formatTime: one instant, three zones", () => {
  it("tape: HH:mm:ss, 24 hour", () => {
    expect(formatTime(AT, "en-US", "UTC", "tape")).toBe("05:04:22");
    expect(formatTime(AT, "en-US", "Asia/Shanghai", "tape")).toBe("13:04:22");
    expect(formatTime(AT, "en-US", "local", "tape")).toBe("22:04:22");
    expect(formatTime(AT, "zh-CN", "Asia/Shanghai", "tape")).toBe("13:04:22");
  });

  it("tab: MM/DD HH:mm:ss (the separator after the date follows the locale)", () => {
    expect(formatTime(AT, "zh-CN", "UTC", "tab")).toBe("10/02 05:04:22");
    expect(formatTime(AT, "zh-CN", "Asia/Shanghai", "tab")).toBe("10/02 13:04:22");
    expect(formatTime(AT, "zh-CN", "local", "tab")).toBe("10/01 22:04:22");
    expect(formatTime(AT, "en", "UTC", "tab")).toBe("10/02, 05:04:22");
    expect(formatTime(AT, "en", "local", "tab")).toBe("10/01, 22:04:22");
  });

  it("short: MM/DD HH:mm", () => {
    expect(formatTime(AT, "zh-CN", "UTC", "short")).toBe("10/02 05:04");
    expect(formatTime(AT, "zh-CN", "Asia/Shanghai", "short")).toBe("10/02 13:04");
    expect(formatTime(AT, "zh-CN", "local", "short")).toBe("10/01 22:04");
  });

  it("clock (time only), datetime and full carry the zone through", () => {
    expect(formatTime(AT, "en-US", "UTC", "clock")).toBe("05:04:22");
    expect(formatTime(AT, "en-US", "Asia/Shanghai", "clock")).toBe("13:04:22");
    expect(formatTime(AT, "en", "UTC", "datetime")).toBe("10/2/2026, 05:04:22");
    expect(formatTime(AT, "en", "Asia/Shanghai", "datetime")).toBe("10/2/2026, 13:04:22");
    expect(formatTime(AT, "en", "local", "datetime")).toBe("10/1/2026, 22:04:22");
    expect(formatTime(AT, "zh-CN", "UTC", "full")).toContain("2日");
    expect(formatTime(AT, "zh-CN", "local", "full")).toContain("1日");
  });

  it("chart styles: the axis styles read the (shifted) instant as UTC, the crosshair styles take the zone", () => {
    expect(formatTime(AT, "en-US", "UTC", "axisYear")).toBe("2026");
    expect(formatTime(AT, "en-US", "UTC", "axisMonth")).toBe("Oct");
    expect(formatTime(AT, "en-US", "UTC", "axisDay")).toBe("2");
    expect(formatTime(AT, "en-US", "UTC", "axisTime")).toBe("05:04");
    expect(formatTime(AT, "en-US", "UTC", "axisSeconds")).toBe("05:04:22");
    expect(formatTime(AT, "en-US", "Asia/Shanghai", "crosshair")).toBe("10/02/2026, 13:04");
    expect(formatTime(AT, "en-US", "local", "crosshair")).toBe("10/01/2026, 22:04");
    expect(formatTime(AT, "en-US", "UTC", "crosshairDate")).toBe("10/02/2026");
  });

  it("takes a Date as well as unix ms", () => {
    expect(formatTime(new Date(AT), "en-US", "Asia/Shanghai", "tape")).toBe(formatTime(AT, "en-US", "Asia/Shanghai", "tape"));
  });

  it("shows a dash for an instant that is not a time (NaN, infinity, past the Date range, an invalid Date)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, -8.64e15 - 1, new Date("garbage")]) {
      expect(formatTime(bad, "en-US", "UTC", "tab")).toBe("—");
    }
    expect(formatTime(8.64e15, "en-US", "UTC", "tape")).not.toBe("—");
  });

  it("falls back to en-US for a locale Intl does not recognise (the chart's old behaviour)", () => {
    expect(formatTime(AT, "not a locale", "UTC", "tape")).toBe(formatTime(AT, "en-US", "UTC", "tape"));
  });
});

describe("formatTime with the zone 'local' is byte-identical to the formatting each display site used before P3-09", () => {
  // 各处原来的写法,逐字照抄:tape、Tab、资产页、连接徽标、旧 /orders 与 /transactions、注销回执、图表
  const LEGACY: Record<string, (ms: number, locale: string) => string> = {
    tape: (ms, l) => new Intl.DateTimeFormat(l, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(ms),
    tab: (ms, l) => new Intl.DateTimeFormat(l, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ms),
    short: (ms, l) => new Intl.DateTimeFormat(l, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms),
    clock: (ms, l) => new Date(ms).toLocaleTimeString(l, { hour12: false }),
    datetime: (ms, l) => new Date(ms).toLocaleString(l, { hour12: false }),
    full: (ms, l) => new Date(ms).toLocaleString(l, { dateStyle: "medium", timeStyle: "short" }),
    crosshair: (ms, l) => new Intl.DateTimeFormat(l, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms),
    crosshairDate: (ms, l) => new Intl.DateTimeFormat(l, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(ms),
  };
  // 午夜、正午、夏令时切换前后、年末、1970 之前
  const INSTANTS = [AT, new Date(2026, 9, 2, 0, 5, 3).getTime(), new Date(2026, 9, 2, 12, 0, 0).getTime(), Date.UTC(2026, 2, 8, 9, 59, 59), Date.UTC(2026, 2, 8, 10, 0, 0), Date.UTC(2026, 11, 31, 23, 59, 59), -86_400_000 * 400];

  it.each(Object.keys(LEGACY))("%s, for en / en-US / zh-CN", (style) => {
    for (const locale of ["en", "en-US", "zh-CN"]) {
      for (const ms of INSTANTS) {
        // crosshairDate 原来是 UTC(日线),其余按浏览器时区;这里 zone 对应原来的写法
        const zone = style === "crosshairDate" ? "UTC" : "local";
        expect(formatTime(ms, locale, zone, style as TimeStyle), `${style} ${locale} ${ms}`).toBe(LEGACY[style](ms, locale));
      }
    }
  });

  it("the chart's axis styles equal the old UTC-pinned formats", () => {
    const old = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(AT);
    expect(formatTime(AT, "en-US", "UTC", "axisYear")).toBe(old({ year: "numeric" }));
    expect(formatTime(AT, "en-US", "UTC", "axisMonth")).toBe(old({ month: "short" }));
    expect(formatTime(AT, "en-US", "UTC", "axisDay")).toBe(old({ day: "numeric" }));
    expect(formatTime(AT, "en-US", "UTC", "axisTime")).toBe(old({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
    expect(formatTime(AT, "en-US", "UTC", "axisSeconds")).toBe(old({ hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }));
  });

  it("'local' is the machine's zone: it equals the same instant formatted with that zone's name, and differs from UTC", () => {
    for (const style of ["tape", "tab", "short", "clock", "datetime", "full", "crosshair"] as const) {
      expect(formatTime(AT, "en-US", "local", style), style).toBe(formatTime(AT, "en-US", LOCAL_ZONE, style));
      expect(formatTime(AT, "en-US", "local", style), style).not.toBe(formatTime(AT, "en-US", "UTC", style));
    }
  });
});

/** 数 Intl.DateTimeFormat 的构造次数,实例仍是真的(缓存里留下的必须能用) */
function spyOnConstructions() {
  const Original = Intl.DateTimeFormat;
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (this: unknown, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new Original(locales, options);
  } as unknown as typeof Intl.DateTimeFormat);
}

describe("formatTime cache", () => {
  it("builds one Intl.DateTimeFormat per (locale, zone, style) and reuses it", () => {
    const spy = spyOnConstructions();
    try {
      // 用本文件里其它用例没碰过的 locale,保证这几次都是第一次
      const locale = "de-DE";
      formatTime(AT, locale, "UTC", "tab");
      expect(spy).toHaveBeenCalledTimes(1);
      formatTime(AT + 1000, locale, "UTC", "tab");
      formatTime(AT + 2000, locale, "UTC", "tab");
      expect(spy).toHaveBeenCalledTimes(1);
      formatTime(AT, locale, "Asia/Shanghai", "tab"); // 换时区
      expect(spy).toHaveBeenCalledTimes(2);
      formatTime(AT, locale, "UTC", "tape"); // 换样式
      expect(spy).toHaveBeenCalledTimes(3);
      formatTime(AT, "fr-FR", "UTC", "tab"); // 换 locale
      expect(spy).toHaveBeenCalledTimes(4);
      formatTime(AT, locale, "UTC", "tab");
      formatTime(AT, locale, "Asia/Shanghai", "tab");
      formatTime(AT, "fr-FR", "UTC", "tab");
      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("'local' passes no timeZone to Intl; the other zones pass theirs", () => {
    const spy = spyOnConstructions();
    try {
      formatTime(AT, "es-ES", "local", "tape");
      formatTime(AT, "es-ES", "Asia/Shanghai", "tape");
      const options = spy.mock.calls.map((call) => call[1]);
      expect(options[0]).not.toHaveProperty("timeZone");
      expect(options[1]).toMatchObject({ timeZone: "Asia/Shanghai" });
    } finally {
      spy.mockRestore();
    }
  });

  it("zoneOffsetSeconds and startOfDayMs cache their formatters too", () => {
    const spy = spyOnConstructions();
    try {
      zoneOffsetSeconds("Asia/Kolkata", AT);
      const first = spy.mock.calls.length;
      expect(first).toBe(1);
      zoneOffsetSeconds("Asia/Kolkata", AT + 5 * 86_400_000);
      startOfDayMs("Asia/Kolkata", AT);
      expect(spy).toHaveBeenCalledTimes(first);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("zoneOffsetSeconds", () => {
  it("UTC is 0 (a plain +0, not -0), Beijing is +28800 all year", () => {
    expect(Object.is(zoneOffsetSeconds("UTC", AT), 0)).toBe(true);
    expect(zoneOffsetSeconds("Asia/Shanghai", AT)).toBe(28_800);
    expect(zoneOffsetSeconds("Asia/Shanghai", Date.UTC(2026, 0, 15))).toBe(28_800);
    expect(zoneOffsetSeconds("Asia/Shanghai", Date.UTC(2026, 6, 15))).toBe(28_800);
  });

  it("follows daylight saving: Los Angeles flips from -8 h to -7 h at 10:00 UTC on 2026-03-08 and back at 09:00 UTC on 2026-11-01", () => {
    const zone = "America/Los_Angeles";
    expect(zoneOffsetSeconds(zone, Date.UTC(2026, 2, 8, 9, 59, 59))).toBe(-28_800);
    expect(zoneOffsetSeconds(zone, Date.UTC(2026, 2, 8, 10, 0, 0))).toBe(-25_200);
    expect(zoneOffsetSeconds(zone, Date.UTC(2026, 10, 1, 8, 59, 59))).toBe(-25_200);
    expect(zoneOffsetSeconds(zone, Date.UTC(2026, 10, 1, 9, 0, 0))).toBe(-28_800);
    // 一个南半球的区:墨尔本 2026-10-04 起是夏令时(+11),之前与 7 月是 +10
    expect(zoneOffsetSeconds("Australia/Melbourne", Date.UTC(2026, 9, 10))).toBe(39_600);
    expect(zoneOffsetSeconds("Australia/Melbourne", Date.UTC(2026, 9, 2))).toBe(36_000);
    expect(zoneOffsetSeconds("Australia/Melbourne", Date.UTC(2026, 6, 2))).toBe(36_000);
  });

  it("handles zones whose offset is not a whole number of hours, positive and negative", () => {
    expect(zoneOffsetSeconds("Asia/Kolkata", AT)).toBe(19_800);
    expect(zoneOffsetSeconds("Asia/Kathmandu", AT)).toBe(20_700);
    expect(zoneOffsetSeconds("America/St_Johns", Date.UTC(2026, 0, 15))).toBe(-12_600);
    expect(zoneOffsetSeconds("America/St_Johns", Date.UTC(2026, 6, 15))).toBe(-9_000);
  });

  it("'local' is the browser's offset at that instant (Los Angeles here, with daylight saving), same as the named zone", () => {
    for (const at of [AT, Date.UTC(2026, 0, 15), Date.UTC(2026, 2, 8, 9, 59, 59), Date.UTC(2026, 2, 8, 10, 0, 0), Date.UTC(2026, 10, 1, 8, 59, 59), Date.UTC(2026, 10, 1, 9, 0, 0)]) {
      expect(zoneOffsetSeconds("local", at), String(at)).toBe(zoneOffsetSeconds(LOCAL_ZONE, at));
      expect(zoneOffsetSeconds("local", at), String(at)).toBe(-new Date(at).getTimezoneOffset() * 60);
    }
    expect(zoneOffsetSeconds("local", AT)).toBe(-25_200);
  });

  it("ignores the millisecond part (an instant just before a switch is still on the old offset)", () => {
    expect(zoneOffsetSeconds("America/Los_Angeles", Date.UTC(2026, 2, 8, 9, 59, 59, 999))).toBe(-28_800);
  });
});

describe("startOfDayMs", () => {
  it("UTC: the midnight of the UTC day, also before 1970", () => {
    expect(startOfDayMs("UTC", AT)).toBe(Date.UTC(2026, 9, 2));
    expect(startOfDayMs("UTC", Date.UTC(2026, 9, 2))).toBe(Date.UTC(2026, 9, 2));
    expect(startOfDayMs("UTC", Date.UTC(2026, 9, 2) - 1)).toBe(Date.UTC(2026, 9, 1));
    expect(startOfDayMs("UTC", -1)).toBe(-86_400_000);
  });

  it("Beijing: 00:00 +08:00, which is 16:00 UTC the day before", () => {
    expect(startOfDayMs("Asia/Shanghai", AT)).toBe(Date.UTC(2026, 9, 1, 16)); // AT 在北京是 10-02 13:04
    expect(startOfDayMs("Asia/Shanghai", Date.UTC(2026, 9, 1, 16))).toBe(Date.UTC(2026, 9, 1, 16));
    expect(startOfDayMs("Asia/Shanghai", Date.UTC(2026, 9, 1, 16) - 1)).toBe(Date.UTC(2026, 8, 30, 16));
  });

  it("a day with a daylight-saving change is 23 or 25 hours long (Los Angeles), and the start is still local midnight", () => {
    const zone = "America/Los_Angeles";
    const spring = startOfDayMs(zone, Date.UTC(2026, 2, 8, 20, 0)); // 03-08 13:00 PDT
    expect(spring).toBe(Date.UTC(2026, 2, 8, 8)); // 00:00 PST
    expect(startOfDayMs(zone, Date.UTC(2026, 2, 9, 20, 0))).toBe(Date.UTC(2026, 2, 9, 7)); // 03-09 00:00 PDT
    expect(Date.UTC(2026, 2, 9, 7) - spring).toBe(23 * 3_600_000);
    // 切换之后的那一刻(03:00 PDT)与切换之前的那一刻(01:59 PST)都落在同一天
    expect(startOfDayMs(zone, Date.UTC(2026, 2, 8, 10, 0, 0))).toBe(spring);
    expect(startOfDayMs(zone, Date.UTC(2026, 2, 8, 9, 59, 59))).toBe(spring);
    const fall = startOfDayMs(zone, Date.UTC(2026, 10, 1, 20, 0)); // 11-01 12:00 PST
    expect(fall).toBe(Date.UTC(2026, 10, 1, 7)); // 00:00 PDT
    expect(startOfDayMs(zone, Date.UTC(2026, 10, 2, 20, 0))).toBe(Date.UTC(2026, 10, 2, 8)); // 11-02 00:00 PST
    expect(Date.UTC(2026, 10, 2, 8) - fall).toBe(25 * 3_600_000);
    // 第二个 01:30(PST)仍在 11-01 这一天
    expect(startOfDayMs(zone, Date.UTC(2026, 10, 1, 9, 30))).toBe(fall);
  });

  it("a zone whose daylight saving starts at midnight has no 00:00 that day: the day starts at 01:00 (São Paulo, 2018-11-04)", () => {
    expect(startOfDayMs("America/Sao_Paulo", Date.UTC(2018, 10, 4, 15))).toBe(Date.UTC(2018, 10, 4, 3));
    expect(startOfDayMs("America/Sao_Paulo", Date.UTC(2018, 10, 4, 3))).toBe(Date.UTC(2018, 10, 4, 3));
    expect(startOfDayMs("America/Sao_Paulo", Date.UTC(2018, 10, 4, 2, 59))).toBe(Date.UTC(2018, 10, 3, 3)); // 前一天 00:00 -03:00
  });

  it("daysBack: the midnight N calendar days before, also across a daylight-saving switch (a day there is 23 or 25 hours; not N x 24 h)", () => {
    expect(startOfDayMs("UTC", AT, 0)).toBe(startOfDayMs("UTC", AT));
    expect(startOfDayMs("UTC", AT, 6)).toBe(Date.UTC(2026, 8, 26));
    expect(startOfDayMs("UTC", AT, 29)).toBe(Date.UTC(2026, 8, 3));
    expect(startOfDayMs("Asia/Shanghai", AT, 6)).toBe(Date.UTC(2026, 8, 25, 16)); // 09-26 00:00 +08:00
    const zone = "America/Los_Angeles";
    const afterSpring = Date.UTC(2026, 2, 11, 1, 0); // 03-10 18:00 PDT
    expect(startOfDayMs(zone, afterSpring, 2)).toBe(Date.UTC(2026, 2, 8, 8)); // 03-08 00:00 PST(23 小时的那天)
    expect(startOfDayMs(zone, afterSpring, 6)).toBe(Date.UTC(2026, 2, 4, 8)); // 03-04 00:00 PST,不是 03-03 23:00
    const afterFall = Date.UTC(2026, 10, 3, 18, 0); // 11-03 10:00 PST
    expect(startOfDayMs(zone, afterFall, 2)).toBe(Date.UTC(2026, 10, 1, 7)); // 11-01 00:00 PDT(25 小时的那天)
    expect(startOfDayMs(zone, afterFall, 29)).toBe(Date.UTC(2026, 9, 5, 7)); // 10-05 00:00 PDT
    // local = 这台机器(钉成洛杉矶)的日历
    expect(startOfDayMs("local", afterSpring, 6)).toBe(startOfDayMs(zone, afterSpring, 6));
    expect(startOfDayMs("local", afterFall, 29)).toBe(startOfDayMs(zone, afterFall, 29));
  });

  it("'local' is the browser's calendar day (setHours), the same as the named zone, across both switches", () => {
    for (const at of [AT, Date.UTC(2026, 2, 8, 20, 0), Date.UTC(2026, 2, 9, 20, 0), Date.UTC(2026, 10, 1, 20, 0), Date.UTC(2026, 10, 1, 9, 30), Date.UTC(2026, 10, 2, 20, 0)]) {
      expect(startOfDayMs("local", at), String(at)).toBe(startOfDayMs(LOCAL_ZONE, at));
    }
    const noon = new Date(2026, 9, 2, 12, 34, 56).getTime();
    expect(startOfDayMs("local", noon)).toBe(new Date(2026, 9, 2).getTime());
  });

  it("is idempotent and never later than the instant", () => {
    for (const zone of ["local", "UTC", "Asia/Shanghai", "America/Los_Angeles", "Asia/Kolkata", "Australia/Lord_Howe"]) {
      for (const at of [AT, Date.UTC(2026, 2, 8, 10), Date.UTC(2026, 10, 1, 9), Date.UTC(2026, 3, 5, 15)]) {
        const start = startOfDayMs(zone, at);
        expect(start, `${zone} ${at}`).toBeLessThanOrEqual(at);
        expect(at - start, `${zone} ${at}`).toBeLessThan(25 * 3_600_000);
        expect(startOfDayMs(zone, start), `${zone} ${at}`).toBe(start);
      }
    }
  });
});

describe("zoneLabel", () => {
  it("UTC, UTC+8, with minutes where the offset has them, and the sign for the west", () => {
    expect(zoneLabel("UTC", AT)).toBe("UTC");
    expect(zoneLabel("Asia/Shanghai", AT)).toBe("UTC+8");
    expect(zoneLabel("Asia/Kolkata", AT)).toBe("UTC+5:30");
    expect(zoneLabel("Asia/Kathmandu", AT)).toBe("UTC+5:45");
    expect(zoneLabel("America/St_Johns", Date.UTC(2026, 0, 15))).toBe("UTC-3:30");
    expect(zoneLabel("America/Los_Angeles", Date.UTC(2026, 6, 1))).toBe("UTC-7");
    expect(zoneLabel("America/Los_Angeles", Date.UTC(2026, 0, 1))).toBe("UTC-8");
    expect(zoneLabel("Europe/London", Date.UTC(2026, 0, 1))).toBe("UTC");
  });

  it("'local' reads the browser's offset at that instant", () => {
    expect(zoneLabel("local", AT)).toBe("UTC-7");
    expect(zoneLabel("local", Date.UTC(2026, 0, 15))).toBe("UTC-8");
  });
});

// ------------------------------------------------------------------ 唯一入口
describe("time-format.ts is the only place that builds a date formatter for display", () => {
  const SRC = fileURLToPath(new URL("../", import.meta.url));
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "generated") walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(relative(SRC, full).split("\\").join("/"));
    }
  })(SRC);
  const code = (file: string) => readFileSync(join(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const using = (re: RegExp) => files.filter((file) => re.test(code(file)));

  it("no other file creates an Intl.DateTimeFormat for the UI (shadow.ts formats a server-side data day, not a time the user reads)", () => {
    expect(using(/\bDateTimeFormat\b/)).toEqual(["lib/real-sync/shadow.ts", "lib/time-format.ts"]);
  });

  it("nobody calls toLocaleTimeString / toLocaleDateString, reads getTimezoneOffset, or passes date options to toLocaleString", () => {
    expect(using(/toLocale(?:Time|Date)String\(/)).toEqual([]);
    expect(using(/getTimezoneOffset\(/)).toEqual(["lib/time-format.ts"]);
    expect(using(/toLocaleString\([^)]*\b(?:dateStyle|timeStyle|hour12|hour|minute|second|month|day|year)\b/)).toEqual([]);
  });

  it("the module is plain: no React, no storage; format.ts (imported by the Nav, in the floor bundle) does not import it", () => {
    const own = code("lib/time-format.ts");
    expect(own).not.toMatch(/from ["']react["']|localStorage|["']use client["']/);
    expect(own).not.toMatch(/from ["']@\/providers\/(?!timeZoneState["'])/); // 偏好只引类型(timeZoneState),不引存储与 hook
    expect(code("lib/format.ts")).not.toMatch(/time-format|useTimeZone|timeZoneState/);
  });
});
