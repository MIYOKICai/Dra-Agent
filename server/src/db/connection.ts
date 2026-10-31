/**
 * SQLite 连接（better-sqlite3 单例）：
 * - 数据库文件位于数据目录 <dataDir>/dra-agent.db（桌面版经 DRA_DATA_DIR 重定向到 userData）
 * - WAL 模式：读写并发友好；foreign_keys=ON：级联删除与引用完整性
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths';

let db: Database.Database | null = null;

/** 获取全局唯一的数据库连接（首次调用时打开并完成 PRAGMA 初始化） */
export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, 'dra-agent.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}
