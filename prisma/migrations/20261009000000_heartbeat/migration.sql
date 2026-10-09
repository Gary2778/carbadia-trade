-- 看门狗写入探针(docs/superpowers/specs/2026-10-09-watchdog-alerts-design.md §3.2):只建一张单行表,不动已有表,旧镜像可直接回滚(多出的表它不读)。
-- IF NOT EXISTS:docker-entrypoint.sh 的 P3009 自愈会删掉未完成记录并重放整份迁移,没有它重放就卡在「already exists」(见 20261002000000 的说明)。
-- CreateTable
CREATE TABLE IF NOT EXISTS "Heartbeat" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL
);
