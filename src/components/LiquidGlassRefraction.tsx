"use client";

import { useEffect } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { renderDisplacementMap } from "./liquidGlassMap";

// 液态玻璃的边缘折射:给 dark 下的玻璃元素挂 `backdrop-filter: url(#…)`,滤镜是一张按元素尺寸生成的位移贴图
// (数学在 liquidGlassMap.ts)。只有 Chromium 支持在 backdrop-filter 里引用 SVG 滤镜;Safari / Firefox 当没写,
// 退路是「全透明 + 高光」。触屏设备不做(背后的星空每帧都在动,每块玻璃都得跟着重算),系统「降低透明度」也不做。
//
// 只给「直接落在页面上」的玻璃做:带 backdrop-filter 的元素是 backdrop root,里面的后代再写 backdrop-filter
// 只能看到祖先内部画的东西,看不到页面——卡片里的小标签折射了也是空的,直接跳过。
// 导航条因此不做 backdrop-filter(它的模糊由身后的兄弟层 .glass-scrim 承担),条里的胶囊按钮才能折射页面。
// 元素来来去去(客户端换页)靠 MutationObserver;尺寸变了重生成贴图(ResizeObserver);离开视口就摘掉滤镜。
//
// 性能账:背后的星空一动、页面一滚,每块玻璃的 backdrop-filter 都要整块重算。所以——
// 贴图按尺寸缓存(滚回视口只是把样式挂回去,不重生成)、一帧最多生成两张、大面单次位移、色散只给小件、
// 对比 / 饱和的提亮和折射写在同一条 backdrop-filter 里(一个元素只开一层 backdrop 面)。

const SELECTOR = [
  "[data-glass]",
  ".shadow-card:not(.glass-overlay)",
  ".glass-control",
  ".ex-panel",
  ".ex-stat",
  ".ex-market-body",
  ".ex-project-card",
  ".ex-button:not(.primary):not(.ghost)",
].join(", ");
const NESTED_IN = `${SELECTOR}, .glass-overlay`;
const SVG_NS = "http://www.w3.org/2000/svg";
// 透过玻璃的东西拉一点对比和饱和:黑更黑、星更亮,才清澈(不用 brightness,它把玻璃底下的黑整体抬亮就是一层灰)。
// 样式表里不再单独写这条:不折射的浏览器连 backdrop 面都不开
const GLASS_TINT = "contrast(1.12) saturate(1.55)";
const MAX_MAP_PIXELS = 160_000; // 贴图最多这么多像素(位移场很平滑,拉伸回去看不出);大卡片按比例缩小生成
const MAPS_PER_FRAME = 2; // 每张贴图要跑一遍像素循环 + PNG 编码,一屏卡片别堆在同一帧
// 色散只给小件(胶囊、按钮、小标签):要三次位移 + 三次通道矩阵 + 两次合成,卡片那么大的面 GPU 吃不消,单次位移。
// 阈值按 CSS 像素面积;大面的边上少了那一点彩,看不出来
const DISPERSION_MAX_AREA = 60_000;
// 红、绿、蓝各弯一次,蓝比红多弯 5%(真玻璃里蓝光折射率更高),再把三个通道加回一张图。
// 中央贴图是「不动」,三次都是原样,加起来还是原样;只有边缘带上三色错开,像水晶边上的那一点彩。
const DISPERSION: { channel: "R" | "G" | "B"; scale: number; keep: string }[] = [
  { channel: "R", scale: 0.95, keep: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { channel: "G", scale: 1, keep: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" },
  { channel: "B", scale: 1.05, keep: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" },
];

type Glass = {
  el: HTMLElement;
  filter: SVGFilterElement;
  image: SVGFEImageElement;
  displaces: SVGFEDisplacementMapElement[]; // 单次位移一个;色散时红、绿、蓝各一个
  dispersed: boolean | null; // 当前链是哪种;null = 还没建
  base: string; // 样式表里原有的 backdrop-filter(一般没有),折射接在它后面
  key: string; // 上次生成贴图时的尺寸 / 圆角;没变就不重生成
  visible: boolean;
};

type Measure = { width: number; height: number; radius: number; key: string };

function refractionSupported() {
  // backdrop-filter: url() 只有 Chromium 会渲染;`@supports` 在 Safari 也返回 true,只能看 UA 特征
  return (
    "userAgentData" in navigator &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-transparency: reduce)").matches
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function cornerRadius(el: HTMLElement, width: number): number {
  const raw = getComputedStyle(el).borderTopLeftRadius;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.trim().endsWith("%") ? (width * value) / 100 : value; // rounded-full 是 3.4e38px,贴图那边会夹到半边
}

function measure(el: HTMLElement): Measure {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const radius = cornerRadius(el, width);
  return { width, height, radius, key: `${width}x${height}x${radius}` };
}

function displacementMap(): SVGFEDisplacementMapElement {
  const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
  displace.setAttribute("in", "SourceGraphic");
  displace.setAttribute("in2", "map");
  displace.setAttribute("xChannelSelector", "R");
  displace.setAttribute("yChannelSelector", "G");
  return displace;
}

function composite(a: string, b: string, result?: string): SVGFECompositeElement {
  const add = document.createElementNS(SVG_NS, "feComposite");
  add.setAttribute("in", a);
  add.setAttribute("in2", b);
  add.setAttribute("operator", "arithmetic");
  add.setAttribute("k2", "1");
  add.setAttribute("k3", "1");
  if (result) add.setAttribute("result", result);
  return add;
}

/** 重建滤镜链:单次位移,或红绿蓝三次位移再合成 */
function buildChain(g: Glass, dispersed: boolean) {
  const primitives: Element[] = [g.image];
  if (!dispersed) {
    g.displaces = [displacementMap()];
    primitives.push(g.displaces[0]);
  } else {
    g.displaces = DISPERSION.map(({ channel, keep }) => {
      const displace = displacementMap();
      displace.setAttribute("result", `bent${channel}`);
      const only = document.createElementNS(SVG_NS, "feColorMatrix");
      only.setAttribute("in", `bent${channel}`);
      only.setAttribute("type", "matrix");
      only.setAttribute("values", keep);
      only.setAttribute("result", `only${channel}`);
      primitives.push(displace, only);
      return displace;
    });
    primitives.push(composite("onlyR", "onlyG", "onlyRG"), composite("onlyRG", "onlyB"));
  }
  g.filter.replaceChildren(...primitives);
  g.dispersed = dispersed;
}

function Refraction() {
  useEffect(() => {
    if (!refractionSupported()) return;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    document.body.appendChild(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return () => svg.remove();

    const glasses = new Map<HTMLElement, Glass>();
    const dirty = new Set<HTMLElement>();
    let flushId = 0;
    let seq = 0;

    /** 按尺寸生成贴图并写进滤镜(链的种类也按面积定) */
    function render(g: Glass, m: Measure) {
      const { width, height, radius } = m;
      const dispersed = width * height <= DISPERSION_MAX_AREA;
      if (dispersed !== g.dispersed) buildChain(g, dispersed);
      const shorter = Math.min(width, height);
      // 折射带要厚:短边的六成、最多 40px(卡片 40、导航胶囊 22);最大位移按带宽七成,带越厚弯得越多
      const band = Number(g.el.dataset.glassBand) || clamp(shorter * 0.6, 14, 40);
      const shift = Number(g.el.dataset.glassShift) || Math.round(band * 0.7);
      const resolution = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / (width * height)));
      const map = renderDisplacementMap({ width, height, radius, band }, resolution);
      canvas.width = map.width;
      canvas.height = map.height;
      const pixels = ctx!.createImageData(map.width, map.height);
      pixels.data.set(map.data);
      ctx!.putImageData(pixels, 0, 0);
      g.image.setAttribute("href", canvas.toDataURL("image/png"));
      g.image.setAttribute("width", String(width));
      g.image.setAttribute("height", String(height));
      // 滤镜区域比元素大一圈:边上的像素要从元素外面取样,取样点得在区域里
      g.filter.setAttribute("x", String(-shift));
      g.filter.setAttribute("y", String(-shift));
      g.filter.setAttribute("width", String(width + 2 * shift));
      g.filter.setAttribute("height", String(height + 2 * shift));
      // 通道 255 ↔ +shift px;色散时三个通道各自的倍率
      g.displaces.forEach((displace, i) => displace.setAttribute("scale", (2 * shift * (dispersed ? DISPERSION[i].scale : 1)).toFixed(2)));
      g.key = m.key;
    }

    function attach(g: Glass) {
      g.el.style.backdropFilter = `${g.base && g.base !== "none" ? `${g.base} ` : ""}${GLASS_TINT} url(#${g.filter.id})`;
    }

    function flush() {
      flushId = 0;
      let budget = MAPS_PER_FRAME;
      for (const el of dirty) {
        const g = glasses.get(el);
        if (!g || !g.visible || !el.isConnected) {
          dirty.delete(el);
          continue;
        }
        const m = measure(el);
        if (!m.width || !m.height) {
          el.style.removeProperty("backdrop-filter");
          dirty.delete(el);
          continue;
        }
        if (m.key !== g.key) {
          if (budget === 0) continue; // 这一帧的贴图额度用完了,留到下一帧
          budget--;
          render(g, m);
        }
        attach(g);
        dirty.delete(el);
      }
      if (dirty.size) flushId = window.requestAnimationFrame(flush);
    }
    function markDirty(el: HTMLElement) {
      dirty.add(el);
      if (!flushId) flushId = window.requestAnimationFrame(flush);
    }

    const resizer = new ResizeObserver((entries) => entries.forEach((entry) => markDirty(entry.target as HTMLElement)));
    const viewer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const g = glasses.get(entry.target as HTMLElement);
          if (!g) continue;
          g.visible = entry.isIntersecting;
          if (g.visible) markDirty(g.el);
          else g.el.style.removeProperty("backdrop-filter");
        }
      },
      { rootMargin: "160px" },
    );

    function add(el: HTMLElement) {
      // 终端(TerminalShell 根节点 data-glass="off")退出玻璃:整棵子树不折射;SELECTOR 里的 [data-glass] 会选中它自己,closest 含自身
      if (el.closest('[data-glass="off"]')) return;
      if (glasses.has(el) || el.parentElement?.closest(NESTED_IN)) return;
      const filter = document.createElementNS(SVG_NS, "filter");
      filter.id = `liquid-glass-${++seq}`;
      filter.setAttribute("filterUnits", "userSpaceOnUse");
      filter.setAttribute("color-interpolation-filters", "sRGB"); // 不写就按 linearRGB 读贴图,128 不再是「不动」
      const image = document.createElementNS(SVG_NS, "feImage");
      image.setAttribute("x", "0");
      image.setAttribute("y", "0");
      image.setAttribute("preserveAspectRatio", "none");
      image.setAttribute("result", "map");
      filter.append(image);
      svg.appendChild(filter);
      glasses.set(el, { el, filter, image, displaces: [], dispersed: null, base: getComputedStyle(el).backdropFilter, key: "", visible: false });
      resizer.observe(el);
      viewer.observe(el);
    }
    function drop(g: Glass) {
      resizer.unobserve(g.el);
      viewer.unobserve(g.el);
      g.el.style.removeProperty("backdrop-filter");
      g.filter.remove();
      glasses.delete(g.el);
      dirty.delete(g.el);
    }
    function scan(root: ParentNode) {
      if (root instanceof HTMLElement && root.matches(SELECTOR)) add(root);
      root.querySelectorAll<HTMLElement>(SELECTOR).forEach(add);
    }

    const mutations = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach((node) => node instanceof HTMLElement && scan(node));
      for (const g of glasses.values()) if (!g.el.isConnected) drop(g);
    });
    scan(document.body);
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      window.cancelAnimationFrame(flushId);
      for (const g of [...glasses.values()]) drop(g);
      resizer.disconnect();
      viewer.disconnect();
      svg.remove();
    };
  }, []);
  return null;
}

export function LiquidGlassRefraction() {
  const { theme } = useTheme();
  return theme === "dark" ? <Refraction /> : null;
}
