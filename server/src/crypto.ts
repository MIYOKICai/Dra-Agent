/**
 * 服务端密钥管理：
 * - getMasterKey()：AES-256-GCM 主密钥（加密 platform_keys 等敏感数据）
 *   优先读环境变量 DRA_MASTER_KEY（base64，32 字节）；否则读写 <dataDir>/master.key
 * - getJwtSecret()：JWT 签名密钥，优先读 DRA_JWT_SECRET；否则生成并持久化到 <dataDir>/jwt.secret
 * - encryptSecret / decryptSecret：AES-256-GCM 加解密，密文格式 JSON {iv, tag, data}（均 base64）
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths';

const MASTER_KEY_FILE = path.join(dataDir, 'master.key');
const JWT_SECRET_FILE = path.join(dataDir, 'jwt.secret');

const PERMISSION_HINT =
  '请确保该文件仅服务运行账户可读（Linux/macOS 建议 chmod 600），并纳入备份但不提交到代码仓库';

function ensureDataDir(): void {
  mkdirSync(dataDir, { recursive: true });
}

/** 主密钥（32 字节）单例缓存 */
let masterKey: Buffer | null = null;

/**
 * 获取 AES-256-GCM 主密钥（32 字节）：
 * 1. 环境变量 DRA_MASTER_KEY（base64 编码的 32 字节，格式非法直接抛错，避免静默用错密钥）
 * 2. <dataDir>/master.key 文件（base64 文本）；不存在则生成随机 32 字节写入
 */
export function getMasterKey(): Buffer {
  if (masterKey) {
    return masterKey;
  }
  const envKey = process.env.DRA_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== 32) {
      throw new Error('DRA_MASTER_KEY 必须是 32 字节的 base64 字符串');
    }
    masterKey = buf;
    return masterKey;
  }
  ensureDataDir();
  if (existsSync(MASTER_KEY_FILE)) {
    const buf = Buffer.from(readFileSync(MASTER_KEY_FILE, 'utf-8').trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(`主密钥文件格式非法（须为 32 字节的 base64）：${MASTER_KEY_FILE}`);
    }
    masterKey = buf;
    return masterKey;
  }
  masterKey = randomBytes(32);
  writeFileSync(MASTER_KEY_FILE, masterKey.toString('base64') + '\n', { mode: 0o600 });
  console.warn(
    `[dra-agent-crypto] 已生成主密钥并写入 ${MASTER_KEY_FILE}（用于敏感数据 AES-256-GCM 加密）；${PERMISSION_HINT}`
  );
  return masterKey;
}

/** JWT 签名密钥单例缓存 */
let jwtSecret: string | null = null;

/**
 * 获取 JWT 签名密钥：
 * 1. 环境变量 DRA_JWT_SECRET
 * 2. <dataDir>/jwt.secret 文件；不存在则生成随机 32 字节（hex）持久化，日志警告提醒配置
 */
export function getJwtSecret(): string {
  if (jwtSecret) {
    return jwtSecret;
  }
  const envSecret = process.env.DRA_JWT_SECRET;
  if (envSecret) {
    jwtSecret = envSecret;
    return jwtSecret;
  }
  ensureDataDir();
  if (existsSync(JWT_SECRET_FILE)) {
    jwtSecret = readFileSync(JWT_SECRET_FILE, 'utf-8').trim();
    return jwtSecret;
  }
  jwtSecret = randomBytes(32).toString('hex');
  writeFileSync(JWT_SECRET_FILE, jwtSecret + '\n', { mode: 0o600 });
  console.warn(
    `[dra-agent-crypto] 未配置 DRA_JWT_SECRET，已生成随机密钥并持久化到 ${JWT_SECRET_FILE}；${PERMISSION_HINT}`
  );
  return jwtSecret;
}

/** AES-256-GCM 密文载荷（platform_keys.encrypted 等字段的存储格式） */
export interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM 加密：返回 JSON 字符串 {iv, tag, data}（均 base64），可直接落库 */
export function encryptSecret(plaintext: string, key: Buffer = getMasterKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const payload: EncryptedPayload = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
  return JSON.stringify(payload);
}

/** AES-256-GCM 解密：入参为 encryptSecret 产出的 JSON 字符串 */
export function decryptSecret(payloadJson: string, key: Buffer = getMasterKey()): string {
  const payload = JSON.parse(payloadJson) as EncryptedPayload;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}
