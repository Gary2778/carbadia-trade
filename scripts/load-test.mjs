// scripts/load-test.mjs — 用法: node scripts/load-test.mjs [baseUrl]
// 模拟发布波峰: 行情轮询为主(与前端 2s 轮询同型), 混合首页 HTML 与单标的行情
import { spawnSync } from "node:child_process";

const base = process.argv[2] ?? "http://localhost:3000";
const scenarios = [
  { name: "assets-poll(列表轮询)", url: `${base}/api/assets`, connections: 200, duration: 30 },
  { name: "symbol-poll(标的页轮询)", url: `${base}/api/assets/VCS-FOR-2021`, connections: 100, duration: 30 },
  { name: "home-html(首页)", url: `${base}/`, connections: 50, duration: 30 },
];
for (const s of scenarios) {
  console.log(`\n=== ${s.name} · c=${s.connections} · ${s.duration}s ===`);
  spawnSync("npx", ["-y", "autocannon", "-c", String(s.connections), "-d", String(s.duration), "--latency", s.url], { stdio: "inherit" });
}
