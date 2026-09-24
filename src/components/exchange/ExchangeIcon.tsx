import type { CSSProperties } from "react";
export type IconName =
  | "market"
  | "dashboard"
  | "projects"
  | "trade"
  | "portfolio"
  | "orders"
  | "retire"
  | "activity"
  | "star"
  | "research"
  | "learn"
  | "account"
  | "search"
  | "arrow"
  | "chevron"
  | "close"
  | "check"
  | "menu"
  | "plus"
  | "external"
  | "info"
  | "forest"
  | "sun"
  | "water"
  | "flame"
  | "wind"
  | "layers"
  | "download";
const paths: Record<IconName, React.ReactNode> = {
  market: (
    <>
      <path d="M4 20V10m8 10V4m8 16V7" />
      <path d="m2 7 7-4 6 2 7-4" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  projects: (
    <>
      <path d="M3 9 12 3l9 6v11H3Z" />
      <path d="M9 20v-8h6v8" />
    </>
  ),
  trade: (
    <>
      <path d="M3 7h17m-5-5 5 5-5 5M21 17H4m5-5-5 5 5 5" />
    </>
  ),
  portfolio: (
    <>
      <rect x="3" y="7" width="18" height="14" rx="2" />
      <path d="M8 7V3h8v4M3 12h18m-12 0v3h6v-3" />
    </>
  ),
  orders: (
    <>
      <path d="M6 3h12v19l-3-2-3 2-3-2-3 2ZM9 8h6m-6 4h6m-6 4h3" />
    </>
  ),
  retire: (
    <>
      <path d="M20 3C7 2 2 7 5 15c8 4 16-2 15-12ZM4 21 15 10" />
    </>
  ),
  activity: (
    <>
      <path d="M2 12h5l3-8 4 16 3-8h5" />
    </>
  ),
  star: (
    <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 9.6l6.3-.9Z" />
  ),
  research: (
    <>
      <path d="M4 3v18h18M8 15l4-6 4 3 5-8" />
    </>
  ),
  learn: (
    <>
      <path d="M12 5C8 2 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-2-10 1Zm0 0v15" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m4 12 5 5L20 6" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  plus: <path d="M12 4v16M4 12h16" />,
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  forest: (
    <>
      <path d="m12 2 6 8h-3l5 7H4l5-7H6Zm0 15v5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
    </>
  ),
  water: (
    <>
      <path d="M12 2c3 5 7 9 7 13a7 7 0 0 1-14 0c0-4 4-8 7-13Z" />
      <path d="M8 16c0 2 2 3 4 3" />
    </>
  ),
  flame: (
    <path d="M12 2c2 5-2 7 1 10 2-1 3-3 3-5 9 12-3 19-9 12C1 12 9 9 12 2Z" />
  ),
  wind: (
    <>
      <path d="M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h6a3 3 0 1 1-3 3" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 2v13m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
};
export function ExchangeIcon({
  name,
  size = 18,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
