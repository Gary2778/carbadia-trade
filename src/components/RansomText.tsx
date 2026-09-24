"use client";

import { useTheme } from "@/providers/ThemeProvider";

// Ransom-note 风格的"剪报字"：每个字母不同字体/纸色/倾斜/大小，像从杂志上剪下来拼贴。
// 仅在深色模式启用；浅色模式保持原样的干净标题。

// 纸片配色（贴近 Peppa 的明亮糖果色） + 文字色
const PAPERS: { bg: string; fg: string }[] = [
  { bg: "#ffffff", fg: "#16161a" },
  { bg: "#1a1a1f", fg: "#fdf6e3" },
  { bg: "#ffd23f", fg: "#16161a" }, // 黄
  { bg: "#ff7eb6", fg: "#16161a" }, // Peppa 粉
  { bg: "#7ee0a6", fg: "#0b2a1a" }, // 薄荷绿
  { bg: "#7cc7ff", fg: "#0a2438" }, // 天蓝
  { bg: "#ff6b5e", fg: "#fff" }, // 番茄红
  { bg: "#c9a8ff", fg: "#1c1233" }, // 淡紫
];

const FONTS = [
  'Georgia, "Times New Roman", serif',
  '"Courier New", ui-monospace, monospace',
  'Impact, "Haettenschweiler", sans-serif',
  '"Trebuchet MS", Verdana, sans-serif',
  '"Arial Black", Arial, sans-serif',
  'Palatino, "Book Antiqua", serif',
];

// 32-bit 整型哈希 → 稳定伪随机，保证 SSR 与客户端一致（不用 Math.random，避免水合漂移）
function hash(str: string, i: number) {
  let h = 2166136261 ^ i;
  for (let k = 0; k < str.length; k++) h = Math.imul(h ^ str.charCodeAt(k), 16777619);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296; // 0..1
}

/** 单个字符的稳定剪报参数（颜色/字体/倾斜/大小），hero 动画与 RansomText 共用。 */
export function ransomParts(text: string, i: number) {
  const paper = PAPERS[Math.floor(hash(text, i * 3 + 1) * PAPERS.length) % PAPERS.length];
  const font = FONTS[Math.floor(hash(text, i * 3 + 2) * FONTS.length) % FONTS.length];
  const rot = (hash(text, i * 3 + 3) - 0.5) * 15; // ±7.5°
  const scale = 0.92 + hash(text, i * 7 + 5) * 0.26; // 0.92–1.18 倍大小
  const dy = (hash(text, i * 11 + 9) - 0.5) * 0.12; // 轻微上下错位（em）
  return { bg: paper.bg, fg: paper.fg, font, rot, scale, dy };
}

/** 给定文本与字符下标，返回稳定的剪报样式（静态用法，含 transform）。 */
export function ransomStyle(text: string, i: number): React.CSSProperties {
  const p = ransomParts(text, i);
  return {
    background: p.bg,
    color: p.fg,
    fontFamily: p.font,
    transform: `rotate(${p.rot.toFixed(2)}deg) scale(${p.scale.toFixed(3)})`,
    translate: `0 ${p.dy.toFixed(3)}em`,
  };
}

export function RansomText({ text, className }: { text: string; className?: string }) {
  const { theme } = useTheme();
  if (theme !== "dark") return <span className={className}>{text}</span>;
  return (
    <span className={className} aria-label={text}>
      {/* 阿拉伯文字母连写:逐字符拆成独立 span 会破坏字形,按词拆分 */}
      {(/[؀-ۿ]/.test(text) ? text.split(/(\s+)/).filter(Boolean) : [...text]).map((ch, i) =>
        /^\s+$/.test(ch) ? (
          <span key={i}>{" "}</span>
        ) : (
          <span key={i} aria-hidden className="ransom-letter" style={ransomStyle(text, i)}>
            {ch}
          </span>
        )
      )}
    </span>
  );
}
