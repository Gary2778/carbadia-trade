"use client";

import { useSyncExternalStore } from "react";

// 邮箱拆成两段、仅在客户端拼装并渲染:
// 服务端渲染的 HTML 里不出现 "hello@carbadia.io" 这个完整字符串,
// 常见的正则爬虫抓不到,真人浏览器(执行 JS)正常看到可点击的 mailto。
const PARTS = ["hello", "carbadia.io"];

// 服务端快照恒为 false、客户端恒为 true → 水合后第一次客户端渲染即显示邮箱
const subscribe = () => () => {};
const useMounted = () => useSyncExternalStore(subscribe, () => true, () => false);

export function ContactEmail({ className = "" }: { className?: string }) {
  const mounted = useMounted();
  if (!mounted) return <span className={className} aria-hidden>……</span>;
  const addr = `${PARTS[0]}@${PARTS[1]}`;
  return (
    <a href={`mailto:${addr}`} className={className}>
      {addr}
    </a>
  );
}
