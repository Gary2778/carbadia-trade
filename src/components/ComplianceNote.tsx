"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 行动点合规提示(下单/挂牌等处):简短一行,中英双语。
 * 完整合规声明在页脚 Footer。
 */
export function ComplianceNote({ className = "" }: { className?: string }) {
  const t = useT("compliance");
  return <p className={`text-[11px] leading-relaxed text-muted ${className}`}>{t.text}</p>;
}
