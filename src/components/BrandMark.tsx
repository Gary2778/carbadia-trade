// Carbadia 品牌标:四格叶子(2026-10-03 定稿的 Logo_Icon,原稿在 Carbadia 主站仓库主检出的 Logo images/)。
// 颜色是品牌色,不随浅色 / dark 外观变;品牌绿 #2ee27f 与 dark 外观的 --accent 相同。
// 导航栏与分享预览图共用这份几何;浏览器图标 src/app/icon.svg 是同一组路径。
// viewBox 1500:四格各 750,蓝格右上角与黄格两角是半径 525 的圆角。
export function BrandMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1500 1500" aria-hidden="true" className={className}>
      <path fill="#2ee27f" d="M0 0H750V750H0Z" />
      <path fill="#5271ff" d="M750 0H975C1264.29 0 1500 235.71 1500 525V750H750Z" />
      <path fill="#ffde59" d="M0 750H225C514.29 750 750 985.71 750 1275V1500H525C235.71 1500 0 1264.29 0 975Z" />
      <path fill="#38b6ff" d="M750 750H1500V1500H750Z" />
    </svg>
  );
}
