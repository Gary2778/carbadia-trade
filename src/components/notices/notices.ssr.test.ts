import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "@/shared";
import type { Lang } from "@/i18n/config";
import coreEn from "@/i18n/messages/core/en";
import coreZhCN from "@/i18n/messages/core/zh-CN";
import copyEn from "@/i18n/messages/notices/en";
import copyZhCN from "@/i18n/messages/notices/zh-CN";
import { NoticeBell, badgeText } from "./NoticeBell";
import { Headline, NoticeList, isPlainLeftClick } from "./NoticeList";
import { ErrorState } from "@/components/ui/ErrorState";
import { PanelBoundary } from "./PanelBoundary";
import { formatNoticeTime } from "./notice-text";

// 通知列表、铃铛的服务端标记测试(node 环境,不引 jsdom;§9.1 第 7 条)与目录的依赖纪律。
// 语言:LangProvider 的上下文不导出,按模块边界打桩成可切换的当前语言(其余导出原样;只用核心命名空间,不需要终端文案的 Provider)。
const i18n = vi.hoisted(() => ({ lang: "en" as Lang }));
vi.mock("@/i18n/LangProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/LangProvider")>();
  const CORE = { en: (await import("@/i18n/messages/core/en")).default, "zh-CN": (await import("@/i18n/messages/core/zh-CN")).default };
  return {
    ...actual,
    useLang: () => ({ lang: i18n.lang, setLang: () => {} }),
    useT: (ns: keyof typeof CORE.en) => CORE[i18n.lang][ns],
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/otc" }));

beforeEach(() => {
  i18n.lang = "en";
});

const TS = new Date(2026, 9, 2, 13, 4, 22).getTime();
const base = { createdAt: TS, readAt: null } as const;
const NOTICES: Record<"fill" | "triggered" | "rejected" | "cancelled" | "alert", Notice> = {
  fill: { ...base, id: "n-fill", kind: "fill", orderId: "o-1", symbol: "VCS-FOR-2021", side: "BUY", role: "MAKER", quantity: 10, price: 6850, orderStatus: "FILLED" },
  triggered: { ...base, id: "n-trig", kind: "trigger", triggerId: "t-1", symbol: "GS-WIND-2022", outcome: "TRIGGERED", reason: null, side: "SELL", quantity: 5, triggerPrice: 7200, orderId: "o-2" },
  rejected: { ...base, id: "n-rej", kind: "trigger", triggerId: "t-2", symbol: "CCER-SOL-2023", outcome: "REJECTED", reason: "NO_FILL", side: "BUY", quantity: 20, triggerPrice: 3000, orderId: "o-3" },
  cancelled: { ...base, id: "n-can", kind: "trigger", triggerId: "t-3", symbol: "VCS-FOR-2021", outcome: "CANCELLED", reason: "OCO", side: "SELL", quantity: 5, triggerPrice: 6500, orderId: null },
  alert: { ...base, id: "n-alert", kind: "price_alert", triggerId: "t-4", symbol: "CDM-METH-2019", direction: "BELOW", triggerPrice: 2000, firedPrice: 1990 },
};
const list = (items: Notice[], onNavigate?: () => void) => renderToStaticMarkup(createElement(NoticeList, { items, onNavigate }));
// 标的代码外面的不换行 span 不算分隔:去掉它再把其余标签换成「|」
const text = (html: string) => html.replace(/<span class="whitespace-nowrap">([^<]*)<\/span>/g, "$1").replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");

describe("NoticeList: every kind, both languages", () => {
  it.each(["en", "zh-CN"] as const)("%s: a headline with the project, side, tonnes and price, then the reason and the time, linking to the project's terminal page", (lang) => {
    i18n.lang = lang;
    const t = lang === "en" ? copyEn : copyZhCN;
    const time = formatNoticeTime(TS, lang, "local");
    const html = list(Object.values(NOTICES));
    expect(html.split("<li").length - 1).toBe(5);
    // 标的页链接:每条一个
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/trade/VCS-FOR-2021", "/trade/GS-WIND-2022", "/trade/CCER-SOL-2023", "/trade/VCS-FOR-2021", "/trade/CDM-METH-2019"]);
    const plain = text(html);
    const act = (buy: boolean, qty: string, symbol: string) => t.act({ buy, qty, symbol });
    expect(plain).toContain(t.fill({ buy: true, qty: "10", symbol: "VCS-FOR-2021", price: "$68.50" }));
    expect(plain).toContain(t.trigger.TRIGGERED({ act: act(false, "5", "GS-WIND-2022"), price: "$72.00" }));
    expect(plain).toContain(t.trigger.NO_FILL({ act: act(true, "20", "CCER-SOL-2023"), price: "$30.00" }));
    expect(plain).toContain(t.trigger.CANCELLED({ act: act(false, "5", "VCS-FOR-2021"), price: "$65.00" }));
    expect(plain).toContain(t.alert({ symbol: "CDM-METH-2019", up: false, price: "$19.90", alertPrice: "$20.00" }));
    // 原因与时间在第二行;只有被拒 / 被撤才有原因
    expect(plain).toContain(`${t.noFillReason.buy} · ${time}`);
    expect(plain).toContain(`${t.reason.OCO} · ${time}`);
    expect(html.split(time).length - 1).toBe(5);
    // 时间不在中间断行
    expect(html).toContain(`<span class="whitespace-nowrap">${time}</span>`);
  });

  it("marks unread notices (darker row, a dot, 'Unread' for screen readers) and leaves read ones plain", () => {
    const html = list([NOTICES.fill, { ...NOTICES.alert, readAt: TS + 1 }]);
    const [unreadRow, readRow] = html.split("<li").slice(1);
    expect(unreadRow).toContain("data-unread");
    expect(unreadRow).toMatch(/ bg-surface-2"/);
    expect(unreadRow).toContain("bg-accent");
    expect(unreadRow).toContain(`<span class="sr-only">${copyEn.unread} </span>`);
    expect(readRow).not.toContain("data-unread");
    expect(readRow).not.toMatch(/ bg-surface-2"/); // 悬停底色 hover:bg-surface-2/60 每行都有,不算
    expect(readRow).not.toContain("bg-accent");
    expect(readRow).not.toContain("sr-only");
  });

  it("never breaks a symbol at its hyphens", () => {
    expect(list([NOTICES.fill])).toContain('<span class="whitespace-nowrap">VCS-FOR-2021</span>');
    // 句子里找不到代码时原样输出,不丢字
    expect(renderToStaticMarkup(createElement(Headline, { text: "Bought 10 t", symbol: "ZZ" }))).toBe("Bought 10 t");
    expect(renderToStaticMarkup(createElement(Headline, { text: "Bought 10 t of ZZ at $1.00", symbol: "ZZ" }))).toBe('Bought 10 t of <span class="whitespace-nowrap">ZZ</span> at $1.00');
  });

  it("does not prefetch the project pages it links to (like the other lists added in Phase 3)", () => {
    expect(codeOf("NoticeList.tsx")).toMatch(/<Link\s+href=\{noticeHref\(notice\)\}\s+prefetch=\{false\}/);
  });

  it("'Load more' and the error state's button are at least 44 px tall on touch devices", () => {
    expect(codeOf("NoticePanel.tsx")).toMatch(/aria-busy=\{state\.more === "loading"\}\s+className="[^"]*pointer-coarse:min-h-touch/);
    expect(renderToStaticMarkup(createElement(ErrorState, { message: "x", onRetry: () => {} }))).toMatch(/<button[^>]*class="[^"]*pointer-coarse:min-h-touch/);
  });

  it("lists nothing for an empty page (the panel shows its empty state instead)", () => {
    expect(list([])).toBe('<ul class="flex flex-col gap-0.5"></ul>');
  });

  it("closes the panel only on a plain left click: a modifier click or a middle click opens a new tab and leaves the panel alone", () => {
    const click = (over: Partial<Parameters<typeof isPlainLeftClick>[0]> = {}) => isPlainLeftClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
    expect(click()).toBe(true);
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) expect(click(over), JSON.stringify(over)).toBe(false);
    // 链接的 onClick 只在普通左键时调 onNavigate
    expect(codeOf("NoticeList.tsx")).toMatch(/onClick=\{\(e\) => \{\s*if \(isPlainLeftClick\(e\)\) onNavigate\?\.\(\);\s*\}\}/);
  });
});

describe("NoticeBell (the part that ships in every page's bundle)", () => {
  const bell = () => renderToStaticMarkup(createElement(NoticeBell));

  it("is a 44 px round button named 'Notifications', closed, with a popup but no panel in the markup", () => {
    const html = bell();
    expect(html).toMatch(/<button[^>]*aria-label="Notifications"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("rounded-full");
    expect(html).not.toContain("role=\"dialog\"");
    // SSR 读到的永远是初始 store(未读 0):没有角标
    expect(html).not.toContain("data-badge");
  });

  it("is named in Chinese too", () => {
    i18n.lang = "zh-CN";
    expect(bell()).toContain('aria-label="通知"');
  });

  it("badge text: the number up to 9, then 9+", () => {
    expect([1, 2, 9, 10, 11, 250].map(badgeText)).toEqual(["1", "2", "9", "9+", "9+", "9+"]);
  });

  it("has the unread count in its name, in both languages", () => {
    expect(coreEn.notices.bell(0)).toBe("Notifications");
    expect(coreEn.notices.bell(3)).toBe("Notifications, 3 unread");
    expect(coreZhCN.notices.bell(0)).toBe("通知");
    expect(coreZhCN.notices.bell(3)).toBe("通知，3 条未读");
  });
});

// ---- 目录的依赖纪律:铃铛随根布局进每个页面的 floor 包,面板懒加载;终端文案与市场 store 一个都不许拖进来 ----
const DIR = fileURLToPath(new URL("./", import.meta.url));
const FILES = readdirSync(DIR).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name));
const source = (name: string) => readFileSync(DIR + name, "utf8");
const codeOf = (name: string) => source(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const importsOf = (name: string) => [...codeOf(name).matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => ({ type: Boolean(m[1]), dynamic: m[3] !== undefined, spec: m[2] ?? m[3] }));
/** 一个文件的静态(非类型、非 import())引入 */
const staticImports = (name: string) => importsOf(name).filter((i) => !i.type && !i.dynamic).map((i) => i.spec);

describe("NoticeBell popover (open state, pinned from the source: no jsdom)", () => {
  const bell = codeOf("NoticeBell.tsx");

  it("is labelled by its visible heading (no duplicate aria-label), and its height follows short viewports", () => {
    expect(bell).toMatch(/role="dialog"\s+aria-labelledby=\{headingId\}/);
    expect(bell).toMatch(/<h2 id=\{headingId\}/);
    expect(bell).not.toMatch(/role="dialog"[^>]*aria-label=/);
    // 在 24rem 与「视口高度减去导航与间距」里取小的;dvh 让手机地址栏收放时也不超出
    expect(bell).toMatch(/max-h-\[min\(24rem,calc\(100dvh_-_4\.5rem\)\)\] overflow-y-auto/);
  });

  it("closes on outside pointerdown and Esc (focus back to the bell)", () => {
    expect(bell).toMatch(/addEventListener\("pointerdown"/);
    expect(bell).toMatch(/e\.key !== "Escape"[\s\S]*?buttonRef\.current\?\.focus\(\)/);
  });

  it("shows the core error text with a retry when the panel chunk cannot be loaded, and a retry imports again (state machine in panel-load.ts)", () => {
    expect(bell).toMatch(/const first = load\.attempt === 0;\s*return <ErrorState message=\{t\.error\} onRetry=\{\(\) => \(first \? dispatch\(\{ kind: "retry" \}\)/);
    expect(bell).toMatch(/import\("\.\/NoticePanel"\)\.then\(/);
    expect(bell).toMatch(/\}, \[load\]\);/);
    expect(bell).not.toMatch(/\blazy\(/);
    // 组件是函数:useState 的初值与 setPanel 的参数都要包成函数,否则 React 会把它当惰性初始化函数调用(第二次打开时整页崩掉,浏览器里抓到过)
    expect(bell).toMatch(/useState<ComponentType<PanelProps> \| null>\(\(\) => loadedPanel\)/);
    expect(bell).toMatch(/setPanel\(\(\) => m\.NoticePanel\)/);
  });

  it("after the retry fails too (a stale tab after a redeploy can never load the old chunk) the action becomes 'Reload page'", () => {
    expect(bell).toMatch(/: location\.reload\(\)\)\} retryLabel=\{first \? undefined : t\.reload\} \/>/);
    const html = renderToStaticMarkup(createElement(ErrorState, { message: coreEn.notices.error, onRetry: () => {}, retryLabel: coreEn.notices.reload }));
    expect(html).toContain(">Reload page<");
    expect(html).not.toContain(">Retry<");
  });
});

describe("components/notices stays light", () => {
  const ALLOWED = [
    /^react$/,
    /^next\/(link|navigation)$/,
    /^\.\//,
    /^@\/shared(\/precision)?$/,
    /^@\/i18n(\/LangProvider|\/config)?$/,
    /^@\/i18n\/messages\/notices\/(en|zh-CN)$/,
    /^@\/components\/anim\/(Toast|toast-queue)$/,
    /^@\/components\/ui\/(EmptyState|ErrorState|Skeleton)$/,
    /^@\/lib\/http\/client$/,
    // 时间显示:格式化模块与时区偏好(P3-09)。两者都不进 floor:NoticeBell 不引本目录里用到它们的文件
    /^@\/lib\/time-format$/,
    /^@\/providers\/(timeZoneState|useTimeZone)$/,
    /^@\/lib\/market\/(account-store|account-bridge|own-orders|notice-refresh)$/,
  ];

  it("imports only the shared types, the account store, the notice copy and a few small ui pieces (no terminal copy, no market store, no motion)", () => {
    expect(FILES).toEqual(expect.arrayContaining(["NoticeBell.tsx", "NoticePanel.tsx", "NoticeList.tsx", "NoticeToaster.tsx", "notice-text.ts", "notice-pages.ts", "notice-copy.ts", "notice-toast.ts", "panel-load.ts", "PanelBoundary.tsx"]));
    const offenders = FILES.flatMap((name) => importsOf(name).filter((i) => !ALLOWED.some((re) => re.test(i.spec))).map((i) => `${name} → ${i.spec}`));
    expect(offenders).toEqual([]);
    for (const name of FILES) expect(codeOf(name), name).not.toMatch(/useT\(\s*["'](terminal|account)["']/);
  });

  it("keeps the notice sentences out of the floor: the bell and the toaster never import the copy, the text builders or the list statically; only notice-copy.ts imports the copy modules", () => {
    for (const name of ["NoticeBell.tsx", "NoticeToaster.tsx", "panel-load.ts"]) {
      const bad = staticImports(name).filter((spec) => /notice-copy|notice-text|notice-toast|NoticeList|NoticePanel|messages\/notices/.test(spec));
      expect(bad, name).toEqual([]);
    }
    const importers = FILES.filter((name) => importsOf(name).some((i) => /messages\/notices\//.test(i.spec)));
    expect(importers).toEqual(["notice-copy.ts"]);
    // 只有这几个(都是懒加载或随首条通知才加载的)引用 notice-copy
    const users = FILES.filter((name) => staticImports(name).some((spec) => spec === "./notice-copy"));
    expect(users).toEqual(["NoticeList.tsx", "NoticePanel.tsx", "notice-toast.ts"]);
    // 铃铛自己用的文案(名字、标题、加载失败与刷新页面)在 core.notices
    expect(Object.keys(coreEn.notices)).toEqual(["title", "bell", "error", "reload"]);
  });

  it("loads the panel and the toast text lazily, through import() only", () => {
    expect(importsOf("NoticeBell.tsx").filter((i) => i.spec === "./NoticePanel")).toEqual([{ type: false, dynamic: true, spec: "./NoticePanel" }]);
    expect(importsOf("NoticeToaster.tsx").filter((i) => i.spec === "./notice-toast")).toEqual([{ type: false, dynamic: true, spec: "./notice-toast" }]);
    // 铃铛自己不发请求:取数在面板里
    expect(codeOf("NoticeBell.tsx")).not.toMatch(/\bapi\(|\bfetch\(/);
  });

  it("the panel marks only the unread ids it shows (first page and each load-more page), never all, and writes the count back with a stamp", () => {
    const panel = codeOf("NoticePanel.tsx");
    expect(panel).not.toMatch(/all: true|all:true/);
    expect(panel).toMatch(/JSON\.stringify\(\{ ids \}\)/);
    expect(panel).toMatch(/unreadIdsToMark\(items, markedRef\.current\)/);
    expect(panel).toMatch(/const stamp = noticeStamp\(\);\s*api<MarkNoticesReadResponse>\(READ_URL/);
    expect(panel).toMatch(/\(res\) => writeBack\(res\.unread, stamp\)/);
    expect(panel).toMatch(/limit=\$\{PAGE_SIZE\}/);
    // 写回被戳挡掉(更新的 notice 事件 / 换了人)时再读一次服务端,角标不停在偏高的数上
    expect(panel).toMatch(/function writeBack\(count: number, stamp: NoticeStamp\): void \{\s*if \(!accountActions\.setUnreadNotices\(count, stamp\)\) requestNoticeRefresh\("stale"\);/);
    expect(panel.match(/writeBack\(/g)).toHaveLength(3); // 定义 + 首页校正 + 标已读应答
    expect(panel).not.toMatch(/accountActions\.setUnreadNotices\(res\.unread/);
    // 「加载更多」:有请求在途不再发(state 与同步的 ref 两道闸),三个动作都带着游标
    expect(panel).toMatch(/state\.more === "loading" \|\| moreInFlightRef\.current !== null\) return;/);
    expect(panel).toMatch(/dispatch\(\{ kind: "moreStart", cursor \}\)/);
    expect(panel).toMatch(/dispatch\(\{ kind: "moreLoaded", cursor, page \}\)/);
    expect(panel).toMatch(/dispatch\(\{ kind: "moreFailed", cursor \}\)/);
    // 面板内容外面套错误边界(渲染出错不卸掉整页)
    expect(panel).toMatch(/<PanelBoundary>\s*<NoticePanelContent onClose=\{onClose\} \/>\s*<\/PanelBoundary>/);
    // 「加载更多」不用 disabled(有的浏览器里 disabled 会丢焦点);最后一页之后焦点落到新一页第一条
    expect(panel).toMatch(/aria-disabled=\{state\.more === "loading"\}/);
    expect(panel).not.toMatch(/(?<![-\w])disabled=/);
    expect(panel).toMatch(/querySelectorAll\("a"\)\[at\]\?\.focus\(\)/);
  });

  it("the toaster is mounted where the account feed runs (terminal and portfolio page), not in the Nav, and dedupes toasts by notice id", () => {
    expect(codeOf("../terminal/TerminalShell.tsx")).toMatch(/<NoticeToaster \/>/);
    expect(codeOf("../account/AccountPage.tsx")).toMatch(/<NoticeToaster \/>/);
    expect(codeOf("../Nav.tsx")).not.toMatch(/NoticeToaster/);
    expect(codeOf("notice-toast.ts")).toMatch(/dedupeKey: notice\.id/);
    // 逐条收事件(subscribeNotices),不靠渲染读 store:同一批里的几条通知渲染只看得到最后一条
    expect(codeOf("NoticeToaster.tsx")).toMatch(/subscribeNotices\(/);
    expect(codeOf("NoticeToaster.tsx")).not.toMatch(/lastNotice|useLastNotice/);
  });

  it("the unread count is re-read on the two pages that have the account feed (the toaster mounts the tab-comes-back watcher and loads the refresher), never from the floor", () => {
    expect(codeOf("NoticeToaster.tsx")).toMatch(/useEffect\(\(\) => watchNoticeRefresh\(\), \[\]\)/);
    expect(importsOf("NoticeToaster.tsx").map((i) => i.spec)).toContain("@/lib/market/notice-refresh");
    // 铃铛(floor 包)与账户 store 都不引它:重读的实现只随终端 / 资产页走,account-bridge 里登记 / 请求
    expect(importsOf("NoticeBell.tsx").map((i) => i.spec)).not.toContain("@/lib/market/notice-refresh");
    expect(codeOf("../../lib/market/account-store.ts")).not.toMatch(/notice-refresh|refreshUnreadNotices|watchNoticeRefresh/);
    expect(codeOf("../../lib/market/notice-refresh.ts")).toMatch(/registerNoticeRefresher\(\(reason\) => void refreshUnreadNotices\(reason\)\)/);
    // 终端的两条通道:WS 订阅快照到了、轮询的一轮
    const provider = codeOf("../../lib/market/MarketProvider.tsx");
    expect(provider).toMatch(/requestNoticeRefresh\("subscribed"\)/);
    expect(provider).toMatch(/requestNoticeRefresh\("poll"\)/);
  });

  it("the order submitter registers the orders this tab placed, and the toast decision asks that registry", () => {
    expect(codeOf("../../lib/market/order-submit.ts")).toMatch(/rememberOwnOrder\(data\.order\.id\)/);
    expect(codeOf("notice-toast.ts")).toMatch(/isOwn: \(orderId: string\) => boolean = isOwnOrder/);
  });
});

describe("PanelBoundary (a render error inside the panel shows the error state instead of unmounting the page)", () => {
  // React 的服务端渲染不支持错误边界,所以这里不渲染一棵会抛错的树,而是直接取边界的两个半边:
  // getDerivedStateFromError 把边界置为失败,失败态的 render() 给出与「chunk 加载失败」同一个错误态(core.notices.error + 重试),没出错时原样渲染子元素
  it("turns a thrown render error into the failed state, which renders the load-failure text with a retry; otherwise it renders its children", () => {
    expect(PanelBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const healthy = new PanelBoundary({ children: createElement("p", null, "child") });
    expect(renderToStaticMarkup(healthy.render() as never)).toBe("<p>child</p>");
    const failed = new PanelBoundary({ children: createElement("p", null, "child") });
    failed.state = PanelBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(failed.render() as never);
    expect(html).toContain(coreEn.notices.error);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`>Retry<`);
    expect(html).not.toContain("child");
    i18n.lang = "zh-CN";
    expect(renderToStaticMarkup(failed.render() as never)).toContain(coreZhCN.notices.error);
  });

  it("is retried by resetting the boundary (the panel content mounts fresh and loads page one again)", () => {
    expect(codeOf("PanelBoundary.tsx")).toMatch(/onRetry=\{\(\) => this\.setState\(\{ failed: false \}\)\}/);
  });

  it("logs the error it caught", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    new PanelBoundary({ children: null }).componentDidCatch(boom);
    expect(errors).toHaveBeenCalledWith("[notices] panel render failed", boom);
    errors.mockRestore();
  });
});
