import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server 的同名函数 + /trade 布局登记终端文案的那层 Provider(P2-01)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/market/account-store";
import { DEFAULT_FEE_SCHEDULE, type Order } from "@/shared";
import type { DialogProps } from "@/components/ui/Dialog";
import en from "@/i18n/messages/en";
import type { OrderReview } from "@/lib/market/order-draft";
import { ORDERS_HISTORY_HREF, placedNotice, type PlacedNotice } from "@/lib/market/order-submit";
import { FeeLine } from "./FeeLine";
import { DemoFailureNotice, LoginGate, demoFailureOf, loginHrefFor } from "./LoginGate";
import { OrderConfirmDialog, blockRepeatActivation } from "./OrderConfirmDialog";
import { OrderPanel, keepsFormHeight, placedToasts } from "./OrderPanel";
import { PositionSlider } from "./PositionSlider";

// 下单面板的服务端标记测试(计划 §3.1、§4.5、§9.1 第 7 条:node 环境,不引 jsdom;没有 LangProvider 时 useT 落到英文)。
//
// zustand 5 在服务端渲染时读 getInitialState()(账户 status 恒为 idle),store 里写什么都进不了 SSR 标记;
// 要画出「未登录」这一支,只能在模块边界替换 useAccountStatus(同 Nav.ssr.test.ts 对 next/navigation 的打桩),其余导出保持真实实现。
// sequence:同一次渲染里先后几次调用各返回什么(用完为止)—— 模拟登录态在两遍渲染之间变化(见「保持表单的高度」一组)。
const account = vi.hoisted(() => ({ status: null as AccountStatus | null, sequence: [] as AccountStatus[] }));
vi.mock("@/lib/market/account-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/market/account-store")>();
  return { ...real, useAccountStatus: () => account.sequence.shift() ?? account.status ?? real.useAccountStatus() };
});

// 下单表单用 useRouter(toast 动作「去委托记录」/「登录」做客户端导航);App Router 之外没有上下文,按模块边界打桩,其余导出保持真实实现
vi.mock("next/navigation", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/navigation")>();
  return { ...real, useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }) };
});

// 确认框经 ui/Dialog 渲染:包一层记下它收到的 props(children 是 React 元素树),照常渲染真实的 Dialog ——
// 这样能直接检查确认按钮挂的处理函数,而不是去 grep 源码
const dialog = vi.hoisted(() => ({ last: null as DialogProps | null }));
vi.mock("@/components/ui/Dialog", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/Dialog")>();
  const { createElement: h } = await import("react");
  return {
    ...real,
    Dialog: (props: DialogProps) => {
      dialog.last = props;
      return h(real.Dialog, props);
    },
  };
});

afterEach(() => {
  account.status = null;
  account.sequence = [];
  dialog.last = null;
});

/** React 元素树里的全部元素(不展开函数组件,只沿 props.children 走) */
function elementsOf(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) for (const child of node) elementsOf(child, out);
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    elementsOf(node.props.children as ReactNode, out);
  }
  return out;
}

const SYMBOL = "VCS-FOR-2021";
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("OrderPanel(SSR 首屏:账户 status idle)", () => {
  it("画出完整表单:买卖、限价 / 市价、价格 / 数量 / 金额、仓位滑杆、feeDemo 手续费行;核对按钮在登录态未知时禁用", () => {
    const html = render(createElement(OrderPanel, { symbol: SYMBOL }));
    expect(html).toContain('data-area="order"');
    expect(html).toContain(`>${en.terminal.order.title}<`);
    for (const label of [en.terminal.order.buy, en.terminal.order.sell, en.terminal.order.limit, en.terminal.order.market]) expect(html).toContain(`>${label}<`);
    for (const label of [en.terminal.order.price, en.terminal.order.qty, en.terminal.order.amount, en.terminal.order.positionPct]) expect(html).toContain(`>${escapeHtml(label)}</label>`);
    expect(html).toMatch(/<input[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
    expect(html).toContain('data-fee-line=""');
    expect(html).toContain(`>${en.terminal.order.feeDemo}<`);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Review order<\/button>/);
    // 默认买入(aria-pressed)+ 方向色
    expect(html).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-\(--terminal-up\)[^"]*">Buy</);
    // 类型按钮带 data-order-type(TerminalShell 的 l / m 按它找按钮);默认限价
    expect(html).toMatch(new RegExp(`data-order-type="LIMIT" aria-pressed="true"[^>]*>${en.terminal.order.limit}<`));
    expect(html).toMatch(new RegExp(`data-order-type="MARKET" aria-pressed="false"[^>]*>${en.terminal.order.market}<`));
    // LoginGate 不出现;面板是表单自己的高度,不带「保持表单高度」的标记
    expect(html).not.toContain("data-login-gate");
    expect(html).not.toContain("data-keep-height");
    // 对话框只在打开时挂载
    expect(html).not.toContain("<dialog");
  });

  it("ComplianceNote 文案固定在提交按钮正上方", () => {
    const html = render(createElement(OrderPanel, { symbol: SYMBOL }));
    const note = html.indexOf(escapeHtml(en.compliance.text));
    const submit = html.indexOf('<button type="submit"');
    expect(note).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(note);
    // 两者之间只隔着 </p>:没有别的元素插进来
    expect(html.slice(note, submit)).toBe(`${escapeHtml(en.compliance.text)}</p>`);
  });

  it("initialSide=SELL 时默认卖出", () => {
    const html = render(createElement(OrderPanel, { symbol: SYMBOL, initialSide: "SELL" }));
    expect(html).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-\(--terminal-down\)[^"]*">Sell</);
    expect(html).toContain(`>${en.terminal.order.availableQty}<`);
  });

  it("二次确认对话框经 next/dynamic({ ssr: false }) 懒加载;面板不静态导入它的模块(否则进主 chunk)", () => {
    const src = source("./OrderPanel.tsx");
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/OrderConfirmDialog"\)[\s\S]{0,200}ssr:\s*false/);
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*"\.\/OrderConfirmDialog"/);
  });
});

describe("OrderPanel(未登录)", () => {
  it("status anon 时 LoginGate 替换表单:登录链接带 returnTo=/trade/<symbol>,另有演示账户入口", () => {
    account.status = "anon";
    const html = render(createElement(OrderPanel, { symbol: SYMBOL }));
    expect(html).toContain('data-login-gate=""');
    expect(html).toContain(`href="/login?returnTo=${encodeURIComponent(`/trade/${SYMBOL}`)}"`);
    expect(html).toContain(`>${en.terminal.order.login}<`);
    expect(html).toContain(escapeHtml(en.terminal.order.loginBody));
    expect(html).toContain(`>${escapeHtml(en.login.tryDemo)}<`);
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
    // 挂载时就已经是未登录(站内跳转、手机切到下单页签):没画过表单,面板保持紧凑
    expect(html).not.toContain("data-keep-height");
  });

  it("LoginGate 单独渲染同样的入口", () => {
    const html = render(createElement(LoginGate, { symbol: "GS-WIND-2023" }));
    expect(html).toContain('href="/login?returnTo=%2Ftrade%2FGS-WIND-2023"');
    expect(loginHrefFor("GS-WIND-2023")).toBe("/login?returnTo=%2Ftrade%2FGS-WIND-2023");
    expect(html).toContain(`>${escapeHtml(en.login.tryDemo)}<`);
  });

  it("演示账户失败:429 → 限流秒数、不给重试;其余 → ui.error + 重试;服务端英文原文不上界面", () => {
    expect(demoFailureOf({ kind: "ok", status: 200, data: { id: "u1" } })).toBeNull();
    expect(demoFailureOf({ kind: "rejected", status: 429, message: "Too many requests", retryAfter: 12 })).toEqual({ kind: "rateLimited", retryAfter: 12 });
    expect(demoFailureOf({ kind: "rejected", status: 429, message: null, retryAfter: null })).toEqual({ kind: "error" });
    expect(demoFailureOf({ kind: "rejected", status: 400, message: "Demo accounts are disabled", retryAfter: null })).toEqual({ kind: "error" });
    expect(demoFailureOf({ kind: "uncertain", status: 0 })).toEqual({ kind: "error" });

    const limited = render(createElement(DemoFailureNotice, { failure: { kind: "rateLimited", retryAfter: 12 }, onRetry: () => {} }));
    expect(limited).toContain('role="alert"');
    expect(limited).toContain(`>${en.terminal.toast.rateLimited(12)}<`);
    expect(limited).not.toContain(`>${en.ui.retry}</button>`);
    const failed = render(createElement(DemoFailureNotice, { failure: { kind: "error" }, onRetry: () => {} }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(`>${escapeHtml(en.ui.error)}<`);
    expect(failed).toContain(`>${en.ui.retry}</button>`);
    expect(failed).not.toContain("Demo accounts are disabled");
  });
});

// `?side=` 深链在手机上的布局偏移(P2-08;计划 §4.7、§7.1 CLS < 0.1):服务端不知道登录态,首帧画表单;匿名的登录态查询回来后
// 换成矮得多的 LoginGate,下面的碳元数据、底部 Tab 与页脚上跳(改动前 CLS 约 0.11)。修法是「两者等高」:画过表单的面板换成
// LoginGate 时保持表单的高度。状态切换要两次渲染,SSR 标记测不到,这里钉判定函数与样式规则;浏览器里的 CLS 数字在 docs/perf-report.md。
describe("下单面板:画过表单之后换成 LoginGate 时保持表单的高度", () => {
  it("keepsFormHeight:只有「画过表单、现在未登录」才保持;登录态未知 / 已登录时面板就是表单自己的高度", () => {
    expect(keepsFormHeight("anon", true)).toBe(true);
    expect(keepsFormHeight("anon", false)).toBe(false);
    for (const status of ["idle", "loading", "ready"] as const) {
      expect(keepsFormHeight(status, true)).toBe(false);
      expect(keepsFormHeight(status, false)).toBe(false);
    }
  });

  it("画过表单(登录态未知)之后变成未登录:LoginGate 所在的面板带 data-keep-height", () => {
    // 面板第一遍渲染读到 idle,在渲染期记下「画过表单」(渲染期 setState,React 立刻重跑本组件);第二遍读到 anon ——
    // 一次服务端渲染里走完「画过表单 → 未登录」
    account.sequence = ["idle", "anon"];
    const html = render(createElement(OrderPanel, { symbol: SYMBOL }));
    expect(account.sequence).toEqual([]);
    expect(html).toMatch(/<section data-area="order" data-keep-height=""/);
    expect(html).toContain('data-login-gate=""');
    expect(html).not.toContain("<form");
  });

  it("已登录之后退出(ready → anon)同样保持;登录态一直未知或已登录时不带标记", () => {
    account.sequence = ["ready", "anon"];
    expect(render(createElement(OrderPanel, { symbol: SYMBOL }))).toMatch(/<section data-area="order" data-keep-height=""/);
    for (const status of ["idle", "loading", "ready"] as const) {
      account.sequence = [status, status];
      const html = render(createElement(OrderPanel, { symbol: SYMBOL }));
      expect(html, status).toContain("<form");
      expect(html, status).not.toContain("data-keep-height");
    }
  });

  it("terminal.css:min-height 常数那条规则在;带这个标记的规则只在手机断点(< 48rem)里;常数与 OrderForm 上的提醒一致", () => {
    const css = source("../../app/terminal.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const KEEP = '[data-terminal] [data-area="order"][data-keep-height]';
    const MOBILE = "@media (width < 48rem)";
    // 选择器里带这个标记的每一条规则:选择器、声明、包住它的那个块的开头(从规则往回数花括号;顶层规则为空串)
    const rules: { selector: string; body: string; prelude: string }[] = [];
    for (let at = css.indexOf(KEEP); at !== -1; at = css.indexOf(KEEP, at + KEEP.length)) {
      const bodyStart = css.indexOf("{", at);
      let depth = 0;
      let open = -1;
      for (let i = at; i >= 0 && open === -1; i--) {
        if (css[i] === "}") depth++;
        else if (css[i] === "{") {
          if (depth === 0) open = i;
          else depth--;
        }
      }
      rules.push({
        selector: css.slice(at, bodyStart).trim(),
        body: css.slice(bodyStart + 1, css.indexOf("}", bodyStart)).trim(),
        prelude: open === -1 ? "" : css.slice(css.lastIndexOf("}", open) + 1, open).trim(),
      });
    }

    const height = rules.filter((rule) => rule.selector === KEEP);
    expect(
      height.map((rule) => rule.body),
      `terminal.css 里应当恰好有一条 \`${KEEP} { min-height: <n>rem; }\`:OrderPanel 的 keepsFormHeight 靠它在手机上保持表单的高度。` +
        "规则没了(或改了选择器 / 单位)的话,未登录的 ?side= 深链在手机上的布局偏移会回到约 0.12(docs/perf-report.md「Phase 2 · P2-08」§2)",
    ).toEqual([expect.stringMatching(/^min-height:\s*[\d.]+rem;$/)]);
    for (const rule of rules) {
      expect(
        rule.prelude,
        `terminal.css 的 \`${rule.selector}\` 必须写在 \`${MOBILE}\` 块里(现在在 \`${rule.prelude || "顶层"}\`):` +
          "≥ 48rem 下单面板的高度由网格行决定,带这个标记的规则漏到断点外面会改动桌面 / 平板的下单面板",
      ).toBe(MOBILE);
    }

    // 常数跟着表单走:OrderForm 的 JSX 上写着同一个数(增减表单行要重新量),两边改了一边就在这里失败
    const constant = /min-height:\s*([\d.]+rem)/.exec(height[0].body)?.[1];
    expect(
      source("./OrderPanel.tsx"),
      `OrderPanel.tsx 的 OrderForm 上的提醒应当写着 terminal.css 现在的常数 \`min-height: ${constant}\`:` +
        "改表单(增减一行、改行高 / 间距)或改这个常数之后,两处要一起更新,并重新量手机上的面板高度",
    ).toContain(`min-height: ${constant}`);
  });
});

describe("FeeLine / PositionSlider", () => {
  it("FeeLine:演示费率为 0 显示 feeDemo;非零费率显示金额", () => {
    expect(render(createElement(FeeLine, { notionalCents: 500_000, fees: DEFAULT_FEE_SCHEDULE }))).toContain(`<dd class="tnum text-foreground">${en.terminal.order.feeDemo}</dd>`);
    const paid = render(createElement(FeeLine, { notionalCents: 500_000, fees: { makerBps: 10, takerBps: 10, minFeeCents: 0, demo: true } }));
    expect(paid).toContain('<dd class="tnum text-foreground">5.00</dd>');
    expect(paid).toContain(`>${en.terminal.order.fee}<`);
  });

  it("FeeLine:给了 feeCents 就显示它(确认单的 estFee),不按费率重算", () => {
    expect(render(createElement(FeeLine, { notionalCents: 500_000, fees: DEFAULT_FEE_SCHEDULE, feeCents: 123 }))).toContain('<dd class="tnum text-foreground">1.23</dd>');
    expect(render(createElement(FeeLine, { notionalCents: 500_000, fees: DEFAULT_FEE_SCHEDULE, feeCents: 0 }))).toContain(`>${en.terminal.order.feeDemo}<`);
  });

  it("PositionSlider:range 0..100、刻度 datalist 与快捷按钮、触控高度 h-touch、卖出用 --down", () => {
    const html = render(createElement(PositionSlider, { value: 50, onChange: () => {}, marks: [0, 25, 50, 75, 100], side: "SELL" }));
    const input = /<input[^>]*type="range"[^>]*\/>/.exec(html)?.[0] ?? "";
    expect(input).toContain('min="0"');
    expect(input).toContain('max="100"');
    expect(input).toContain('value="50"');
    expect(input).toMatch(/class="[^"]*\bh-touch\b[^"]*\baccent-down\b/);
    expect(html).toContain('aria-valuetext="50%"');
    expect(html.match(/<option value="\d+">/g)).toHaveLength(5);
    expect(html).toMatch(/aria-pressed="true"[^>]*>50%<\/button>/);
    expect(html.match(/>(\d+)%<\/button>/g)).toEqual([">0%</button>", ">25%</button>", ">50%</button>", ">75%</button>", ">100%</button>"]);
  });
});

describe("OrderConfirmDialog", () => {
  const review: OrderReview = {
    request: { assetId: "asset-1", side: "BUY", type: "LIMIT", price: 10_005, quantity: 30, clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab" },
    estNotional: 300_150,
    estFee: 0,
    estAvgPrice: 10_005,
    warnings: [],
  };
  const instrument = { symbol: SYMBOL, pricePrecision: 2, qtyStep: 1 };
  const props = { review, instrument, onConfirm: () => {}, onCancel: () => {}, busy: false, error: null, uncertain: false };

  it("展示价格 / 数量 / 名义额 / 手续费 0.00 · 演示 / 合规行与演示说明;确认按钮用方向色", () => {
    const html = render(createElement(OrderConfirmDialog, props));
    expect(html).toContain("<dialog");
    expect(html).toContain(`>${en.terminal.order.confirmTitle({ side: en.terminal.order.buy, symbol: SYMBOL })}<`);
    expect(html).toContain(">100.05<");
    expect(html).toContain(">30<");
    expect(html).toContain(">3,001.50<");
    expect(html).toContain(`>${en.terminal.order.feeDemo}<`);
    expect(html).toContain(escapeHtml(en.compliance.text));
    expect(html).toContain(escapeHtml(en.terminal.order.confirmBody));
    expect(html).toMatch(/class="[^"]*bg-\(--terminal-up\)[^"]*">Confirm<\/button>/);
    expect(html).not.toContain(ORDERS_HISTORY_HREF);
  });

  it("结果未确认:错误说明(role=alert)+ 去委托记录核对的链接,确认按钮变重试", () => {
    const html = render(createElement(OrderConfirmDialog, { ...props, error: en.terminal.order.uncertain, uncertain: true }));
    expect(html).toMatch(new RegExp(`role="alert"[^>]*>${escapeHtml(en.terminal.order.uncertain).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
    expect(html).toContain(`href="${escapeHtml(ORDERS_HISTORY_HREF)}"`);
    expect(html).toContain(`>${en.terminal.order.uncertainAction}<`);
    expect(html).toContain(`>${en.ui.retry}</button>`);
  });

  // P1-25d 终审修复:链接去的是 /orders?status=ALL(全部委托),文案原来与底部 Tab「Open orders / 当前委托」同名,
  // 在「结果无法确认」的流程里会让人以为只看挂单
  it("结果未确认的核对入口不与底部「当前委托」Tab 同名,并写明是全部委托", async () => {
    const zhCN = (await import("@/i18n/messages/zh-CN")).default;
    expect(ORDERS_HISTORY_HREF).toContain("status=ALL");
    expect(en.terminal.order.uncertainAction).not.toBe(en.terminal.tabs.open);
    expect(zhCN.terminal.order.uncertainAction).not.toBe(zhCN.terminal.tabs.open);
    expect(en.terminal.order.uncertainAction).toBe("View all orders");
    expect(zhCN.terminal.order.uncertainAction).toBe("查看全部委托");
  });

  it("明确被拒(4xx):按钮仍是 Confirm,不是 Retry;401 给登录入口而不是核对链接", () => {
    const rejected = render(createElement(OrderConfirmDialog, { ...props, error: en.terminal.order.errors.insufficientCash }));
    expect(rejected).toContain(`>${en.terminal.order.confirm}</button>`);
    expect(rejected).not.toContain(`>${en.ui.retry}</button>`);
    expect(rejected).not.toContain(ORDERS_HISTORY_HREF);
    const unauth = render(createElement(OrderConfirmDialog, { ...props, error: en.terminal.toast.loginRequired, loginHref: loginHrefFor(SYMBOL) }));
    expect(unauth).toContain(`href="${escapeHtml(loginHrefFor(SYMBOL))}"`);
    expect(unauth).toContain(`>${en.terminal.order.login}<`);
    expect(unauth).toContain(`>${en.terminal.order.confirm}</button>`);
  });

  it("按住 Enter 的自动重复不激活确认按钮:确认按钮的 keydown 在 e.repeat 时 preventDefault,松开再按照常确认", () => {
    const onConfirm = vi.fn();
    render(createElement(OrderConfirmDialog, { ...props, onConfirm }));
    const buttons = elementsOf(dialog.last?.children).filter((el) => el.type === "button");
    const confirm = buttons.find((el) => el.props.onClick === onConfirm);
    expect(confirm).toBeDefined();
    const onKeyDown = confirm!.props.onKeyDown as typeof blockRepeatActivation;
    expect(onKeyDown).toBe(blockRepeatActivation);

    const held = { repeat: true, preventDefault: vi.fn() };
    onKeyDown(held);
    expect(held.preventDefault).toHaveBeenCalledOnce();
    const pressed = { repeat: false, preventDefault: vi.fn() };
    onKeyDown(pressed);
    expect(pressed.preventDefault).not.toHaveBeenCalled();
    // 取消按钮没有这层拦截(按住 Enter 取消无害)
    expect(buttons.find((el) => el.props.onClick === props.onCancel)?.props.onKeyDown).toBeUndefined();
  });

  it("手续费行显示确认单自己的 estFee(不按默认费率重算)", () => {
    const html = render(createElement(OrderConfirmDialog, { ...props, review: { ...review, estFee: 250 } }));
    expect(html).toMatch(/data-fee-line=""[^]*?<dd class="tnum text-foreground">2\.50<\/dd>/);
    expect(html).not.toContain(`>${en.terminal.order.feeDemo}<`);
  });

  it("市价单显示预估均价;吃不满给提交前的 partialWarning 提示(不是「部分成交」);提交中按钮禁用并显示 submitting", () => {
    const market: OrderReview = { ...review, request: { ...review.request, type: "MARKET", price: null, side: "SELL" }, estAvgPrice: 9_993, warnings: ["partialFill"] };
    const html = render(createElement(OrderConfirmDialog, { ...props, review: market, busy: true }));
    expect(html).toContain(`>${en.terminal.order.estAvg}<`);
    expect(html).toContain(">99.93<");
    expect(html).toMatch(new RegExp(`data-warning="partialFill"[^>]*>${escapeHtml(en.terminal.order.partialWarning).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
    expect(html).not.toContain(`>${en.terminal.order.partial}<`);
    expect(html).toMatch(/disabled=""[^>]*class="[^"]*bg-\(--terminal-down\)[^"]*">Submitting…<\/button>/);
    // 吃得满:没有提示
    expect(render(createElement(OrderConfirmDialog, props))).not.toContain("data-warning");
  });
});

describe("placedToasts(下单成功后的 toast)", () => {
  const T = en.terminal;
  const order = { side: "BUY" as const, quantity: 10, symbol: SYMBOL };
  const notice = (over: Partial<PlacedNotice> = {}): PlacedNotice => ({
    replayed: false,
    state: "filled",
    tone: "ok",
    resetDraft: true,
    showOrdersAction: false,
    selfTradeCancelled: 0,
    ...over,
  });
  const args = { side: T.order.buy, qty: 10, symbol: SYMBOL };

  it("新单:「已提交 · 状态」,语气随 placedNotice,无动作;没有自成交撤单时只有这一条", () => {
    expect(placedToasts(order, notice(), T)).toEqual([{ type: "ok", text: `${T.toast.orderPlaced(args)} · ${T.toast.orderFilled}`, ordersAction: false }]);
    expect(placedToasts(order, notice({ state: "cancelled", tone: "warning" }), T)).toEqual([
      { type: "warning", text: `${T.toast.orderPlaced(args)} · ${T.toast.orderCancelled}`, ordersAction: false },
    ]);
  });

  it("重放:toast.orderReplayed 明说这次没有下新单(不出现「已提交」);有意再下同样的单 → warning + 去委托记录,重试的预期完成 → ok", () => {
    const deliberate = placedToasts(order, notice({ replayed: true, tone: "warning", resetDraft: false, showOrdersAction: true, state: "resting" }), T);
    expect(deliberate).toEqual([{ type: "warning", text: `${T.toast.orderReplayed(args)} · ${T.order.resting}`, ordersAction: true }]);
    expect(deliberate[0].text).not.toContain(T.toast.orderPlaced(args));
    const retried = placedToasts(order, notice({ replayed: true }), T);
    expect(retried).toEqual([{ type: "ok", text: `${T.toast.orderReplayed(args)} · ${T.toast.orderFilled}`, ordersAction: false }]);
    // 卖单用卖出的方向文案
    expect(placedToasts({ ...order, side: "SELL" }, notice({ replayed: true }), T)[0].text).toContain(T.toast.orderReplayed({ ...args, side: T.order.sell }));
  });

  it("自成交防护撤掉了本人挂单(selfTradeCancelled > 0):主提示之后另一条 info;0 不弹", () => {
    expect(placedToasts(order, notice({ selfTradeCancelled: 2 }), T)).toEqual([
      { type: "ok", text: `${T.toast.orderPlaced(args)} · ${T.toast.orderFilled}`, ordersAction: false },
      { type: "info", text: T.toast.selfTradeCancelled(2), ordersAction: false },
    ]);
    expect(placedToasts(order, notice({ selfTradeCancelled: 1 }), T)[1]).toEqual({ type: "info", text: T.toast.selfTradeCancelled(1), ordersAction: false });
    expect(placedToasts(order, notice({ selfTradeCancelled: 0 }), T)).toHaveLength(1);
  });

  it("端到端:响应里的 selfTradeCancelled 经 placedNotice 到 toast(缺省 = P1-07b 之前的服务端,不弹)", () => {
    const placed: Order = {
      ...order,
      id: "order-1",
      clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab",
      assetId: "asset-1",
      type: "MARKET",
      price: null,
      filledQuantity: 10,
      status: "FILLED",
      avgFillPrice: 10_005,
      cancelReason: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const data = { order: placed, filledQty: 10, replayed: false };
    expect(placedToasts(order, placedNotice({ ...data, selfTradeCancelled: 3 }), T).map((x) => x.type)).toEqual(["ok", "info"]);
    expect(placedToasts(order, placedNotice(data), T).map((x) => x.type)).toEqual(["ok"]);
  });
});
