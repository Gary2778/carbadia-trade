// cbda.trade 的路由没有主站时代的 /exchange 前缀。带旧前缀的链接(书签、外站引用)整棵子树平移到根。
// 旧资产页 /portfolio 与 /dashboard 由 /trade/account 取代(计划 §6.2.2 C8,P2-10),两条都跳到新页。
// next.config.ts 与测试共用这张表。Next 16 无 301 / 302:permanent: true → 308(永久),false → 307(临时),都保留请求方法。
// /portfolio 与 /dashboard 先用临时跳转(P2-13,终审 P2-OPS-1):Next 给配置里的跳转不带 Cache-Control,浏览器会把永久跳转
// 长期缓存;一旦回滚到 Phase 1 的镜像(它没有 /trade/account,这个路径落到 /trade/[symbol] → 404),访问过这两个地址的浏览器
// 不再问服务端、一直跳到 404,服务端收不回来。临时跳转每次都问服务端,回滚即恢复。Phase 2 稳定、不再考虑回滚到 Phase 1 之后
// 再改成永久(计划 §6.2.2 C8)。/exchange/* 是 Phase 1 就有的永久跳转,不变。
export const LEGACY_REDIRECTS = [
  { source: "/exchange/:path*", destination: "/:path*", permanent: true },
  { source: "/portfolio", destination: "/trade/account", permanent: false },
  { source: "/dashboard", destination: "/trade/account", permanent: false },
];

/** 回跳目标缺省或不安全时去这里 */
const RETURN_TO_DEFAULT = "/trade/account";
/** 解析相对路径用的固定基址:只用来判断「解析之后还在不在本站」,不出现在返回值里 */
const RETURN_TO_BASE = "https://cbda.trade";
/**
 * 一律拒绝的字符:控制字符(U+0000–U+001F、U+007F)、任何空白(\s 含 U+00A0、U+3000 等)、反斜杠。
 * 浏览器的 URL 解析会先删掉制表符与换行(`/\t/evil.example` → `//evil.example`)、把反斜杠当成斜杠,
 * 只看第二个字符的正则挡不住这些(终审 SEC-1)。
 */
const UNSAFE_RETURN_TO = /[\u0000-\u001F\u007F\s\\]/;

/**
 * 登录 / 注册后的站内回跳目标;只接受站内路径,防 open-redirect。
 * 先拒绝含控制字符、空白、反斜杠的值,再按固定基址解析:必须同源,且原值与解析结果都以单个 `/` 开头
 *(`/.//evil.example` 解析后的路径是 `//evil.example`,交给 router.push 会变成协议相对地址,所以结果也要查)。
 * 返回解析后的 pathname + search + hash;任何一条不满足都回落到资产页。
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || UNSAFE_RETURN_TO.test(raw)) return RETURN_TO_DEFAULT;
  let url: URL;
  try {
    url = new URL(raw, RETURN_TO_BASE);
  } catch {
    return RETURN_TO_DEFAULT;
  }
  if (url.origin !== RETURN_TO_BASE) return RETURN_TO_DEFAULT;
  const target = url.pathname + url.search + url.hash;
  return target.startsWith("/") && !target.startsWith("//") ? target : RETURN_TO_DEFAULT;
}
