// cbda.trade 的路由没有主站时代的 /exchange 前缀。带旧前缀的链接(书签、外站引用)整棵子树平移到根。
// next.config.ts 与测试共用这张表。Next 16 无 301:permanent: true → 308(永久,保留请求方法)。
export const LEGACY_REDIRECTS = [
  { source: "/exchange/:path*", destination: "/:path*", permanent: true },
];

/** 登录/注册后的站内回跳目标;只接受站内相对路径,防 open-redirect */
export function safeReturnTo(raw: string | null | undefined): string {
  if (raw && /^\/(?![/\\])/.test(raw)) return raw;
  return "/portfolio";
}
