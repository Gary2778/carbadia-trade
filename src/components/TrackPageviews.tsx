"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function TrackPageviews() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    fetch("/api/track", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "pageview", path: pathname }),
    }).catch(() => {}); // 埋点失败静默,绝不影响用户
  }, [pathname]);
  return null;
}
