// 时区偏好(计划 §6.3.2 C7):键、取值与纯函数。读写存储走 appearance-storage.ts 的存取函数,订阅在 useTimeZone.ts。
// 单独成模块而不放进 themeState.ts:themeState 从根布局可达(ThemeProvider),时区偏好只有显示时间的页面才用,不进每页的公共包。

export const TZ_KEY = "carbadia-tz"; // 取值见 TZ_PREFS;默认 local

/** 选择器里的顺序;类型从这份清单派生,清单与类型不会各改各的。local = 浏览器时区(默认,不给 Intl 传 timeZone),其余两个是固定的 IANA 区 */
export const TZ_PREFS = ["local", "Asia/Shanghai", "UTC"] as const;
export type TimeZonePref = (typeof TZ_PREFS)[number];

/** 读存储值:只认三个合法值,其余(含未存、非法值)一律 local */
export function readTz(raw: string | null): TimeZonePref {
  return TZ_PREFS.find((pref) => pref === raw) ?? "local";
}
