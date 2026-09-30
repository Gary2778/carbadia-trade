import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastRegions } from "./Toast";
import { splitToastRegions, TOAST_LIVE, type ToastItem, type ToastType } from "./toast-queue";

// Toast 的播报结构(P1-25d 终审修复):原来容器常驻 aria-live="polite",每条 toast 又各带 role="status" / "alert"——
// live region 套 live region,读屏可能把一条读两遍(err 先按 alert 打断读一遍,又按外层 polite 读一遍)。
// 改为两个常驻区域:role="status"(ok / info,礼貌)与 role="alert"(err / warning,打断),条目本身不带角色。
// 区域常驻在 DOM 里,新插入的条目才会被可靠地播报(动态插入一个自带 role="status" 的节点,多数读屏不当作 live 变更)。

const item = (id: number, type: ToastType, text: string): ToastItem => ({ id, type, text, expiresAt: 10_000 });
const ITEMS = [item(1, "ok", "Order submitted"), item(2, "err", "Order rejected"), item(3, "info", "Reconnected"), item(4, "warning", "Polling")];

const count = (html: string, needle: string) => html.split(needle).length - 1;
/** 某个角色区域的开标签到它的闭合 </div> 之间的内容(区域里的条目是 div,按深度配对) */
function regionOf(html: string, role: "status" | "alert"): string {
  const start = html.indexOf(`role="${role}"`);
  if (start === -1) throw new Error(`no role="${role}" region`);
  const open = html.lastIndexOf("<div", start);
  let depth = 0;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = open;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  throw new Error("unbalanced region");
}

describe("splitToastRegions", () => {
  it("routes ok / info to the polite status region and err / warning to the alert region, keeping queue order", () => {
    expect(TOAST_LIVE).toEqual({ ok: "status", info: "status", err: "alert", warning: "alert" });
    const { status, alert } = splitToastRegions(ITEMS);
    expect(status.map((x) => x.id)).toEqual([1, 3]);
    expect(alert.map((x) => x.id)).toEqual([2, 4]);
    expect(splitToastRegions([])).toEqual({ status: [], alert: [] });
  });
});

describe("ToastRegions markup", () => {
  it("renders exactly one polite status region and one assertive alert region, both present while empty", () => {
    const empty = renderToStaticMarkup(createElement(ToastRegions, { items: [], onDismiss: () => {} }));
    expect(count(empty, 'role="status"')).toBe(1);
    expect(count(empty, 'role="alert"')).toBe(1);
    expect(count(empty, "aria-live=")).toBe(2);
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain('aria-live="assertive"');
  });

  it("never nests a live region: the toasts themselves carry no role and no aria-live", () => {
    const html = renderToStaticMarkup(createElement(ToastRegions, { items: ITEMS, onDismiss: () => {} }));
    expect(count(html, 'role="status"')).toBe(1);
    expect(count(html, 'role="alert"')).toBe(1);
    expect(count(html, "aria-live=")).toBe(2);
    // 区域只播报新增的那一条,不把整个区域重读一遍(role=status / alert 默认 aria-atomic=true)
    expect(count(html, 'aria-atomic="false"')).toBe(2);
    const status = regionOf(html, "status");
    const alert = regionOf(html, "alert");
    expect(status).toContain("Order submitted");
    expect(status).toContain("Reconnected");
    expect(status).not.toContain("Order rejected");
    expect(alert).toContain("Order rejected");
    expect(alert).toContain("Polling");
    expect(alert).not.toContain("Order submitted");
    // 两个区域是兄弟,不互相包含
    expect(status).not.toContain('role="alert"');
    expect(alert).not.toContain('role="status"');
  });

  it("keeps the semantic tones and the action button", () => {
    const withAction: ToastItem = { ...item(5, "info", "Order replayed"), action: { label: "View all orders", onClick: () => {} } };
    const html = renderToStaticMarkup(createElement(ToastRegions, { items: [withAction, item(6, "err", "Rejected")], onDismiss: () => {} }));
    expect(html).toContain("text-info");
    expect(html).toContain("text-danger");
    expect(html).toContain(">View all orders</button>");
  });
});
