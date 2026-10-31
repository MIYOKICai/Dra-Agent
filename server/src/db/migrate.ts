/**
 * 迁移执行器：
 * - 首次运行创建 _migrations 版本表（version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT）
 * - 按 version 升序执行未应用的迁移（单迁移内建表 + 版本记录在同一事务中，失败整体回滚）
 * - 幂等：已应用的版本跳过，重复运行无副作用
 *
 * 直跑入口：npm run migrate（tsx src/db/migrate.ts）；也可被服务端启动流程 import 后调用 runMigrations()
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb } from './connection';
import { migrations } from './schema';

/** 执行所有未应用的迁移（幂等，可重复调用） */
export function runMigrations(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(
      (row) => row.version
    )
  );
  const record = db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    const apply = db.transaction(() => {
      for (const sql of migration.sql) {
        db.exec(sql);
      }
      record.run(migration.version, migration.name);
    });
    apply();
    console.log(`[dra-agent-db] 已应用迁移 v${migration.version}: ${migration.name}`);
  }
}

/* 直跑判定：作为脚本执行（npm run migrate）时立即运行迁移 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runMigrations();
}
