// 文案注册表:英文(source of truth)与简体中文,静态导入,编译期保证 key 齐全。
import type { Lang } from "./config";
import en, { type Messages } from "./messages/en";
import zhCN from "./messages/zh-CN";

export const MESSAGES: Record<Lang, Messages> = {
  en,
  "zh-CN": zhCN,
};

export type { Messages };
