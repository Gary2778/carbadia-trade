"use client";

import { useEffect } from "react";
import { motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { fmtMoney, fmtQty } from "@/lib/format";

export function NumberTicker({
  value,
  format = "money",
  className,
}: {
  value: number;
  format?: "money" | "qty";
  className?: string;
}) {
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 80, damping: 20 });
  const text = useTransform(spring, (v) => (format === "money" ? fmtMoney(v) : fmtQty(Math.round(v))));

  useEffect(() => {
    if (reduced) spring.jump(value);
    else spring.set(value);
  }, [value, spring, reduced]);

  return <motion.span className={className}>{text}</motion.span>;
}
