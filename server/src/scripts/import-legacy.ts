/**
 * 旧版单用户数据导入 CLI（商业化 SQLite 多用户改造的存量迁移工具）：
 *
 *   npm run import-legacy -- [--dir <旧数据目录>] [--email <目标用户邮箱>]
 *
 * 旧版结构（读 paths.ts / kb.ts / memory.ts 梳理）：
 * - <dir>/kb/<kbId>/index.json     单用户知识库（KBIndex：info / documents / chunks）
 * - <dir>/profile.json             单文件长期画像 { facts: string[] }
 *
 * 导入行为：
 * - 目标用户：--email 指定；缺省取第一个 admin（users 按 created_at 最早）。无用户时报错退出。
 * - 知识库：整个 <kbId>/ 目录复制到 <dataDir>/files/<userId>/<kbId>/（新多用户布局），
 *   并写 kb_ownership 归属与 kb_docs 文档元数据（实体文件命中 <docId>_* 时记录 file_path）。
 *   向量随 index.json 原样带走（维度不一致时检索自动退化为关键词模式，安全）。
 * - 画像：facts 与该用户 memories.profile 已有条目合并去重后写回。
 * - 幂等：kb 目录 + 归属记录已存在则整库跳过；kb_docs / 归属用 INSERT OR IGNORE；画像合并去重。
 * - <dir> 不存在或无任何旧版数据时打印提示并正常退出（exit 0）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, serverRoot } from '../paths';
import { runMigrations } from '../db/migrate';
import { getDb } from '../db/connection';

interface CliArgs {
  dir: string;
  email: string | null;
}

/** 解析命令行参数：--dir <旧数据目录>（默认 server/data）、--email <目标用户>（默认第一个 admin） */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dir: path.join(serverRoot, 'data'), email: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      args.dir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--email' && argv[i + 1]) {
      args.email = argv[i + 1].trim().toLowerCase();
      i += 1;
    }
  }
  return args;
}

interface LegacyDoc {
  id: string;
  name: string;
  chunkCount: number;
  content?: string;
}

interface LegacyIndex {
  info?: { id?: string; name?: string };
  documents?: LegacyDoc[];
}

/** kbId / docId 形态校验（uuid 形态，阻断路径穿越与脏数据） */
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** 按邮箱查用户；email 为空时取第一个 admin。返回 { id, email } 或 undefined */
function findTargetUser(email: string | null): { id: string; email: string } | undefined {
  const db = getDb();
  if (email) {
    return db
      .prepare('SELECT id, email FROM users WHERE email = ?')
      .get(email) as { id: string; email: string } | undefined;
  }
  return db
    .prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1")
    .get() as { id: string; email: string } | undefined;
}

/** 导入 profile.json：facts 与用户现有 memories.profile 合并去重（无变化则跳过） */
function importProfile(legacyDir: string, user: { id: string; email: string }): boolean {
  const file = path.join(legacyDir, 'profile.json');
  if (!existsSync(file)) {
    return false;
  }
  let facts: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { facts?: unknown };
    if (Array.isArray(parsed.facts)) {
      facts = parsed.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
    }
  } catch {
    console.warn(`  [profile] profile.json 解析失败，跳过（${file}）`);
    return false;
  }
  if (facts.length === 0) {
    return false;
  }
  const db = getDb();
  const row = db.prepare('SELECT profile FROM memories WHERE user_id = ?').get(user.id) as
    | { profile: string | null }
    | undefined;
  let existing: Record<string, unknown> = {};
  if (row?.profile) {
    try {
      const parsed: unknown = JSON.parse(row.profile);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  const merged = new Set(
    Array.isArray(existing.facts) ? (existing.facts as unknown[]).filter((f): f is string => typeof f === 'string') : []
  );
  const before = merged.size;
  for (const fact of facts) {
    merged.add(fact);
  }
  if (merged.size === before) {
    console.log(`  [profile] ${facts.length} 条画像已存在，跳过`);
    return false;
  }
  const next = { ...existing, facts: [...merged] };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (user_id, profile, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`
  ).run(user.id, JSON.stringify(next), now, now);
  console.log(`  [profile] 导入 ${facts.length} 条画像事实（合并后共 ${merged.size} 条）`);
  return true;
}

/** 导入单个知识库目录：复制目录 + 写 kb_ownership / kb_docs。返回是否实际导入 */
function importKBDir(kbDir: string, kbId: string, user: { id: string; email: string }): boolean {
  const indexFile = path.join(kbDir, 'index.json');
  if (!existsSync(indexFile)) {
    return false;
  }
  let index: LegacyIndex;
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8')) as LegacyIndex;
  } catch {
    console.warn(`  [kb] ${kbId} index.json 解析失败，跳过`);
    return false;
  }
  const db = getDb();
  const targetDir = path.join(dataDir, 'files', user.id, kbId);
  // 幂等：归属记录（且目标索引）已存在 → 整库跳过
  const owned = db.prepare('SELECT user_id FROM kb_ownership WHERE kb_id = ?').get(kbId) as
    | { user_id: string }
    | undefined;
  if (owned && existsSync(path.join(targetDir, 'index.json'))) {
    console.log(`  [kb] ${kbId}「${index.info?.name ?? ''}」已导入，跳过`);
    return false;
  }
  if (owned && owned.user_id !== user.id) {
    console.warn(`  [kb] ${kbId} 已归属其他用户（${owned.user_id}），跳过`);
    return false;
  }
  // 复制整个目录（index.json + 文档实体文件）
  mkdirSync(targetDir, { recursive: true });
  for (const name of readdirSync(kbDir)) {
    const src = path.join(kbDir, name);
    if (existsSync(src)) {
      copyFileSync(src, path.join(targetDir, name));
    }
  }
  db.prepare('INSERT OR IGNORE INTO kb_ownership (kb_id, user_id) VALUES (?, ?)').run(kbId, user.id);
  let importedDocs = 0;
  for (const doc of index.documents ?? []) {
    if (!ID_RE.test(doc.id)) {
      continue;
    }
    // 命中 <docId>_<文件名> 形态的实体文件时记录目标路径
    const entity = readdirSync(kbDir).find((name) => name.startsWith(`${doc.id}_`));
    db.prepare(
      `INSERT OR IGNORE INTO kb_docs (id, user_id, kb_id, name, size, chunks, status, file_path)
       VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`
    ).run(
      doc.id,
      user.id,
      kbId,
      doc.name ?? null,
      doc.content ? Buffer.byteLength(doc.content, 'utf8') : null,
      doc.chunkCount ?? null,
      entity ? path.join(targetDir, entity) : null
    );
    importedDocs += 1;
  }
  console.log(
    `  [kb] ${kbId}「${index.info?.name ?? ''}」→ ${targetDir}（${importedDocs} 篇文档）`
  );
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const legacyDir = args.dir;
  console.log(`[import-legacy] 旧数据目录：${legacyDir}`);
  console.log(`[import-legacy] 新数据目录：${dataDir}`);

  if (!existsSync(legacyDir)) {
    console.log('[import-legacy] 未找到旧版数据目录，无需导入，正常退出。');
    return;
  }

  runMigrations();

  const user = findTargetUser(args.email);
  if (!user) {
    console.error(
      args.email
        ? `[import-legacy] 未找到邮箱为 ${args.email} 的用户。请先注册该用户或改用 --email 指定其他账号。`
        : '[import-legacy] 数据库中没有任何 admin 用户（可先注册一个账号，首个用户自动成为 admin），无法确定导入目标。'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[import-legacy] 导入目标用户：${user.email}（${user.id}）`);

  let importedKbs = 0;
  const kbRoot = path.join(legacyDir, 'kb');
  if (existsSync(kbRoot)) {
    for (const entry of readdirSync(kbRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) {
        continue;
      }
      if (importKBDir(path.join(kbRoot, entry.name), entry.name, user)) {
        importedKbs += 1;
      }
    }
  }
  const importedProfile = importProfile(legacyDir, user);

  if (importedKbs === 0 && !importedProfile) {
    console.log('[import-legacy] 未发现可导入的旧版数据（无 kb/ 目录与 profile.json），正常退出。');
    return;
  }
  console.log(`[import-legacy] 完成：导入 ${importedKbs} 个知识库，画像${importedProfile ? '已' : '无需'}导入。`);
}

/* 直跑判定：npm run import-legacy 时执行；被测试 import 时不执行 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
