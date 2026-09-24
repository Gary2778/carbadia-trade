#!/bin/sh
# Railway 容器启动：校验环境 → 迁移 → 仅在空库时灌种子 → 启动（instrumentation 会拉起做市机器人）
set -e

# 启动前校验：配置缺失宁可快速失败，也不要带错误配置静默上线
if [ -z "$DATABASE_URL" ]; then
  echo "[deploy] 错误：DATABASE_URL 未设置，拒绝启动" >&2
  exit 1
fi
case "$DATABASE_URL" in
  file:/data/*) ;;
  *)
    echo "[deploy] 错误：DATABASE_URL 必须以 file:/data/ 开头（否则数据会写进镜像内临时库，重启即丢失）" >&2
    exit 1
    ;;
esac
if [ -z "$SESSION_SECRET" ]; then
  echo "[deploy] 错误：SESSION_SECRET 未设置，拒绝启动" >&2
  exit 1
fi

# 空间兜底：volume 写满时迁移与写入都会失败（SQLite 错误 13）。开机小批量清一点过期成交,
# 给迁移腾页;大头由应用内清理任务分批在线处理(网络卷 IO 慢, 大 DELETE 会把启动卡住几十分钟)。
# 每批一个独立小事务, 默认 journal, 任何时刻中断都安全;首次启动表不存在时报错属预期, || true 兜底。
RETENTION="${RETENTION_DAYS:-7}"
echo "[deploy] 开机清理: 删除 ${RETENTION} 天前的成交(每批 1 万行, 最多 5 批)…"
i=0
while [ $i -lt 5 ]; do
  npx prisma db execute --stdin --url "$DATABASE_URL" <<SQL || break
DELETE FROM "Trade" WHERE rowid IN (
  SELECT t.rowid FROM "Trade" t
  JOIN "User" b ON b.id = t.buyerId
  JOIN "User" s ON s.id = t.sellerId
  WHERE b.isBot = 1 AND s.isBot = 1
    AND t.createdAt < CAST((strftime('%s','now') - $RETENTION * 86400) AS INTEGER) * 1000
  LIMIT 10000
);
SQL
  i=$((i+1))
done

# P3009 自愈：部署重叠期旧容器还在写库，迁移可能被写锁打断并留下"未完成"记录，
# 之后每次启动 migrate deploy 都会拒绝执行。清掉未完成记录让其重放。
# 注意：迁移 SQL 并非全部幂等（cents_and_ledger 的 ×100 转换重放会二次放大），靠下方迁移前备份对冲。
# 首次启动时 _prisma_migrations 表不存在，报错属预期，|| true 兜底。
echo "DELETE FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;" \
  | npx prisma db execute --stdin --url "$DATABASE_URL" || true

# 有待应用迁移时, 先对卷上数据库做一次覆盖式备份(含 WAL/SHM)。
# 防迁移重放/失败: P3009 自愈机制会让未完成迁移重放, 而本次分转换迁移非幂等(重放会把已是分的数据再 ×100), 出事时靠该备份回滚。
DB_FILE="${DATABASE_URL#file:}"
if npx prisma migrate status 2>/dev/null | grep -q "have not yet been applied"; then
  # 时间戳备份而非覆盖: 若"迁移已成功但记录未写入"触发重放, 覆盖式备份会把好备份换成已转换库
  TS="$(date +%s)"
  echo "[entrypoint] pending migrations detected — backing up ${DB_FILE} (.${TS}.bak)"
  cp "$DB_FILE" "${DB_FILE}.pre-migrate.${TS}.bak" 2>/dev/null || true
  cp "${DB_FILE}-wal" "${DB_FILE}-wal.pre-migrate.${TS}.bak" 2>/dev/null || true
  cp "${DB_FILE}-shm" "${DB_FILE}-shm.pre-migrate.${TS}.bak" 2>/dev/null || true
  # 只保留最近 2 组备份, 防卷空间被吃满
  ls -1t "${DB_FILE}".pre-migrate.*.bak 2>/dev/null | tail -n +3 | while read -r f; do rm -f "$f"; done
fi

echo "[deploy] 应用数据库迁移…"
npx prisma migrate deploy

# 重建查询统计: 表重建型迁移会连带删掉 sqlite_stat1, 统计缺失时清理任务的
# DELETE 子查询会选灾难性执行计划并长期霸占写锁(2026-07-17 生产事故)。ANALYZE 幂等,但在生产库上实测要 2~3 分钟(2026-09):
# 这期间新容器尚未就绪、公网短暂 502 属正常,不要中断。
echo "[deploy] ANALYZE 重建查询统计…"
echo "ANALYZE;" | npx prisma db execute --stdin --url "$DATABASE_URL" \
  || echo "[deploy] 警告：ANALYZE 失败（库可能被占用），跳过" >&2

# WAL 模式：读写并发更好，且避免机器人写库时把页面读请求锁住。
# WAL 一经设置持久化在库文件上；若本次因写锁失败，沿用现有模式启动，下次部署再试。
echo "[deploy] 启用 SQLite WAL…"
echo "PRAGMA journal_mode=WAL;" | npx prisma db execute --stdin --url "$DATABASE_URL" \
  || echo "[deploy] 警告：WAL 设置失败（库可能被占用），沿用现有 journal 模式继续启动" >&2

echo "[deploy] 检查种子数据（仅当数据库为空时写入）…"
npm run db:seed:if-empty

echo "[deploy] 启动 Next.js（端口 ${PORT:-3000}）…"
exec npx next start -H 0.0.0.0 -p "${PORT:-3000}"
