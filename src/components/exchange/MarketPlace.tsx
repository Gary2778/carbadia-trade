"use client";

import { useId, useState, type CSSProperties } from "react";
import { getCreditProfile, type CarbonAsset } from "@/lib/exchange/carbon";
import { ExchangeIcon } from "./ExchangeIcon";
import { SpotTable } from "./SpotTable";

export function Stat({
  label,
  value,
  note,
  icon,
  unit,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  icon?: React.ComponentProps<typeof ExchangeIcon>["name"];
  unit?: string;
}) {
  return (
    <div className="ex-stat">
      <div className="ex-stat-top">
        <span>{label}</span>
        {icon && <ExchangeIcon name={icon} size={15} />}
      </div>
      <div className="ex-stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="ex-stat-foot">{note}</div>
    </div>
  );
}
export function Term({
  children,
  definition,
}: {
  children: React.ReactNode;
  definition: string;
}) {
  const id = useId();
  const [position, setPosition] = useState({ top: 0, left: 0 });
  return (
    <>
      <button
        type="button"
        className="ex-term"
        popoverTarget={id}
        aria-describedby={id}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            top: Math.min(rect.bottom + 8, window.innerHeight - 130),
            left: Math.max(10, Math.min(rect.left, window.innerWidth - 280)),
          });
        }}
      >
        {children}
      </button>
      <span
        id={id}
        popover="auto"
        role="tooltip"
        className="ex-term-popover"
        style={position}
      >
        {definition}
      </span>
    </>
  );
}
export function ProjectIcon({
  asset,
}: {
  asset: Pick<CarbonAsset, "symbol" | "projectType">;
}) {
  const p = getCreditProfile(asset);
  return (
    <span
      className="ex-category-icon"
      style={{ "--project-color": p.color } as CSSProperties}
    >
      <ExchangeIcon name={p.icon} size={21} />
    </span>
  );
}
export function MarketPlace({
  watchlistOnly = false,
}: {
  watchlistOnly?: boolean;
}) {
  return <SpotTable watchlistOnly={watchlistOnly} />;
}
