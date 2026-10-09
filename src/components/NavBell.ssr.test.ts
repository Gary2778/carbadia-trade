import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/shared";
import en from "@/i18n/messages/en";
import { Nav } from "./Nav";

// 登录之后的 Nav(Nav.ssr.test.ts 管 SSR / 未登录:那里 store 恒为初始状态,铃铛不画)。真实的服务端渲染拿不到登录态 —— 登录态只在水合之后进 store ——
// 所以这里把账户 store 的几个读取 hook 打桩成「已登录」,看水合之后那一帧的标记:铃铛在右侧常驻的那一组里(所有宽度、不在 xl 才有的账户块里)、
// 44 px 的触控目标、名字里带未读数、角标最多写 9+、没登录就没有。
const account = vi.hoisted(() => ({ status: "ready" as "idle" | "ready" | "anon", me: null as Me | undefined | null, unread: 0 }));
vi.mock("@/lib/market/account-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market/account-store")>();
  return {
    ...actual,
    useAccountStatus: () => account.status,
    useMe: () => account.me,
    useBalance: () => null,
    useUnreadNotices: () => account.unread,
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/otc", useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const alice: NonNullable<Me> = { id: "u-1", email: "a@example.com", name: "Alice", cashBalance: 12_345, lockedCash: 0, unreadNotices: 0 };
const render = () => renderToStaticMarkup(createElement(Nav));
const bellOf = (html: string) => html.match(/<button[^>]*aria-haspopup="dialog"[\s\S]*?<\/button>/)?.[0] ?? "";
/** 右侧控件那一组(ms-auto …)到汉堡按钮为止 */
const clusterOf = (html: string) => html.slice(html.indexOf("ms-auto flex items-center"));

beforeEach(() => {
  account.status = "ready";
  account.me = alice;
  account.unread = 0;
});

describe("Nav bell (logged in)", () => {
  it("is the first control of the right-hand cluster, before the theme toggle, the language menu, the xl-only account block and the hamburger", () => {
    const cluster = clusterOf(render());
    const at = (needle: string) => cluster.indexOf(needle);
    // 这一组靠右对齐、向左长:登录后才出现的铃铛排在最前面,已经在屏幕上的几个控件位置不动(水合后不跳)
    expect(at('aria-haspopup="dialog"')).toBeGreaterThan(-1);
    expect(at('aria-haspopup="dialog"')).toBeLessThan(at("Switch to dark mode"));
    expect(at("Switch to dark mode")).toBeLessThan(at(en.nav.language));
    expect(at(en.nav.language)).toBeLessThan(at("hidden xl:flex"));
    expect(at("hidden xl:flex")).toBeLessThan(at(`aria-label="${en.nav.menu}"`));
    // 铃铛是这一组的第一个子元素,紧跟在容器开标签之后
    expect(cluster).toMatch(/^ms-auto flex items-center gap-1 sm:gap-3 text-sm"><div class="sm:relative"><button[^>]*aria-haspopup="dialog"/);
    // 铃铛不在 xl 才有的块里:那一块里只有现金、名字、退出
    const xlBlock = cluster.slice(at("hidden xl:flex"), at(`aria-label="${en.nav.menu}"`));
    expect(xlBlock).not.toContain('aria-haspopup="dialog"');
    expect(xlBlock).toContain(en.nav.logout);
  });

  it("only adds the bell in front: take it out and the theme toggle and language menu are byte for byte the logged-out ones (they do not move or change)", () => {
    const withBell = clusterOf(render());
    account.status = "anon";
    account.me = null;
    const without = clusterOf(render());
    const stripped = withBell.replace(/<div class="sm:relative">[\s\S]*?<\/button><\/div>/, "");
    expect(stripped).not.toContain('aria-haspopup="dialog"');
    const before = (html: string) => html.slice(0, html.indexOf("hidden xl:flex"));
    expect(before(stripped)).toBe(before(without));
    // 汉堡按钮也一样
    const hamburger = (html: string) => html.slice(html.indexOf(`<button type="button" class="xl:hidden`));
    expect(hamburger(stripped)).toBe(hamburger(without));
  });

  it("is a 44 px round touch target with the semantic popup attributes, and carries no breakpoint hiding class", () => {
    const bell = bellOf(render());
    expect(bell).toContain("h-11 w-11");
    expect(bell).toContain("rounded-full");
    expect(bell).toContain('aria-expanded="false"');
    expect(bell).not.toMatch(/class="[^"]*\b(hidden|sm:hidden|md:hidden|lg:hidden|xl:hidden|max-[^ "]*:hidden)\b/);
  });

  it("without unread notices: named 'Notifications', no badge", () => {
    const bell = bellOf(render());
    expect(bell).toContain('aria-label="Notifications"');
    expect(bell).not.toContain("data-badge");
  });

  it("with unread notices: the count is in the accessible name and the badge shows it (aria-hidden: not read twice), up to 9+", () => {
    account.unread = 3;
    let bell = bellOf(render());
    expect(bell).toContain('aria-label="Notifications, 3 unread"');
    expect(bell).toMatch(/<span data-badge="" aria-hidden="true"[^>]*>3<\/span>/);
    account.unread = 12;
    bell = bellOf(render());
    expect(bell).toContain('aria-label="Notifications, 12 unread"');
    expect(bell).toMatch(/data-badge[^>]*>9\+<\/span>/);
  });

  it("is not there for a visitor, before the login state is known, or while it is still loading", () => {
    account.status = "anon";
    account.me = null;
    expect(render()).not.toContain('aria-haspopup="dialog"');
    account.status = "idle";
    account.me = undefined;
    expect(render()).not.toContain('aria-haspopup="dialog"');
    // 身份已有但状态还没确认(loading 与 idle 一样不画账户区)
    account.me = alice;
    expect(render()).not.toContain('aria-haspopup="dialog"');
  });

  it("keeps the wordmark rule that makes room for it: with the bell the full name needs 360 px, so the leaf stands in below 23.25rem (372 px)", () => {
    const html = render();
    expect(html).toContain("max-[23.25rem]:inline");
    expect(html).toContain("max-[23.25rem]:hidden");
    expect(html).not.toContain("max-[23rem]");
  });
});
