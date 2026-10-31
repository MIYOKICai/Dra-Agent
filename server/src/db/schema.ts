/**
 * 数据库 schema 迁移定义：
 * - 每个迁移 = { version, name, sql[] }，按 version 升序在 migrate.ts 中顺序执行
 * - 时间列统一 TEXT，默认写入 ISO 8601 字符串（等价 CURRENT_TIMESTAMP 的 ISO 形式）
 * - 只追加不修改：已上线的迁移内容视为不可变，变更一律新增迁移
 */

/** 时间列默认值：ISO 8601 字符串（含毫秒与 UTC 时区标记） */
const TS_DEFAULT = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export interface Migration {
  version: number;
  name: string;
  /** 按顺序执行的 SQL 语句 */
  sql: string[];
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'schema-v1',
    sql: [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
        banned INTEGER NOT NULL DEFAULT 0,
        ban_reason TEXT,
        banned_until TEXT,
        token_version INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      `CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        replaced_by TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT},
        last_used_at TEXT
      )`,
      `CREATE TABLE canvases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT,
        data TEXT,
        thumbnail TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      'CREATE INDEX idx_canvases_user ON canvases(user_id)',
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      'CREATE INDEX idx_sessions_user_scope ON sessions(user_id, scope)',
      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT,
        content TEXT,
        meta TEXT,
        seq INTEGER,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      'CREATE INDEX idx_messages_session_seq ON messages(session_id, seq)',
      `CREATE TABLE memories (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      `CREATE TABLE kb_docs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kb_id TEXT NOT NULL,
        name TEXT,
        size INTEGER,
        chunks INTEGER,
        status TEXT,
        file_path TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      'CREATE INDEX idx_kb_docs_user_kb ON kb_docs(user_id, kb_id)',
      `CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL REFERENCES users(id),
        target_type TEXT,
        target_id TEXT,
        target_owner_id TEXT,
        reason TEXT,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
        resolution TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT},
        UNIQUE(reporter_id, target_type, target_id)
      )`,
      `CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT,
        target_id TEXT,
        action TEXT,
        detail TEXT,
        ip TEXT,
        ua TEXT,
        created_at ${TS_DEFAULT}
      )`,
      `CREATE TABLE platform_keys (
        provider TEXT PRIMARY KEY,
        encrypted TEXT NOT NULL,
        updated_at ${TS_DEFAULT}
      )`,
      `CREATE TABLE user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
    ],
  },
  {
    version: 2,
    name: 'schema-v2-kb-ownership',
    sql: [
      `CREATE TABLE kb_ownership (
        kb_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at ${TS_DEFAULT},
        updated_at ${TS_DEFAULT}
      )`,
      'CREATE INDEX idx_kb_ownership_user ON kb_ownership(user_id)',
    ],
  },
];
