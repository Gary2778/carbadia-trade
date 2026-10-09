// 外观键的读写(纯模块,不带 "use client"):读不到 / 写不进存储时留在内存里的兜底,以及两个存取函数 readAppearanceKey / writeAppearanceKey。
// 从 appearance-storage.ts 拆出来,是因为时区偏好(useTimeZone.ts,不在根布局的 floor 包里)也要用同一份存取与兜底:
// 一个模块被 floor 之外的 chunk 也引用时,打包器不再把它并进 ThemeProvider 的模块作用域,floor 多出约 0.15 KB gzip;
// 拆成两个存取函数的小模块,多出的只有它自己的导出表(约 0.04 KB)。appearance-storage.ts 照旧导出这两个函数。

/**
 * 外观两个键(carbadia-theme / carbadia-updown)写不进存储时的内存值:键 → 该写入的值(null = 删除)。
 * 时区偏好(carbadia-tz,useTimeZone.ts)同样经 readAppearanceKey / writeAppearanceKey,共用这份内存兜底。
 * 禁用站点数据(getItem / setItem 都抛 SecurityError)或配额满时,用户点日 / 月、涨跌轴按钮的选择留在这里;
 * 读的时候优先 —— 否则下一次软导航按 pathname 重新派生时读到的是空值(或旧值),选择被撤回(main 只在挂载时读一次存储,
 * 所以内存里的选择能活过软导航)。某个键写成功即清掉它的内存值,以存储为准。模块级:只在浏览器里、用户点按钮时写。
 */
const unsaved = new Map<string, string | null>();

/** 读一个外观键:这次会话写失败过的键取内存值,否则读存储(读抛错 → null) */
export function readAppearanceKey(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写一个外观键(null = 删除):成功则清掉内存值,抛错(禁用站点数据、配额、没有 localStorage)则记进内存 */
export function writeAppearanceKey(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
}
