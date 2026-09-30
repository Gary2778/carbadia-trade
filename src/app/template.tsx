"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";

// 首屏(整页加载 / 水合)不淡入:服务端 HTML 直接是不透明的,LCP 按内容画出的那一刻算,而不是等水合后淡入结束
// (P1-25f 复测:/ 的页头段落从 opacity 0 淡入,移动真实节流 LCP 3.40 s)。之后的站内导航 template 重新挂载,照旧 0.35 s 淡入。
// 模块级标记只在浏览器里、挂载后置位;服务端从不置位,所以 SSR 与水合首帧一致(都不带初始透明度)。
let hydrated = false;

export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [firstLoad] = useState(() => !hydrated);
  useEffect(() => {
    hydrated = true;
  }, []);
  // 终端不做 0.35 s 淡入:首屏即静止的实盘,也不给 /trade 子树套一层 motion 容器(SSR 与首帧一致,无 CLS)
  if (pathname.startsWith("/trade")) return <>{children}</>;
  return (
    <motion.div
      initial={firstLoad ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.21, 0.7, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
