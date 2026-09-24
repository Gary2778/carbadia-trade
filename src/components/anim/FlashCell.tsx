"use client";

import { useEffect, useRef, useState } from "react";

export function FlashCell({
  value,
  children,
  className = "",
}: {
  value: number | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  const prev = useRef<number | null | undefined>(undefined);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const old = prev.current;
    prev.current = value;
    if (old != null && value != null && value !== old) {
      setFlash(value > old ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 600);
      return () => clearTimeout(t);
    }
    if (value == null) setFlash(null);
  }, [value]);

  return (
    <span
      className={`${className} rounded transition-colors duration-500 ${
        flash === "up" ? "bg-up/15" : flash === "down" ? "bg-down/15" : "bg-transparent"
      }`}
    >
      {children}
    </span>
  );
}
