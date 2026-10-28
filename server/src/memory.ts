/**
 * 长期用户画像（对话记忆）：data/profile.json 单文件存储用户的稳定信息条目。
 * - 读取：loadProfileFacts()（Agent 组装 system 注入「[关于用户的长期记忆]」）
 * - 追加：appendProfileFacts(facts)（去重、截断超长、上限 30 条、临时文件 + rename 原子写）
 * - 清空：clearProfile()（DELETE /api/memory）
 * - 提取：extractProfileFacts(adapter, transcript)（LLM 从一段对话中抽取稳定信息，fire-and-forget）
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appConfig } from './config';
import type { ProviderAdapter } from './providers';

/** 条目上限：超出时丢弃最旧 */
const MAX_FACTS = 30;
/** 单条上限字符数（Array.from 保证不截断代理对） */
const MAX_FACT_CHARS = 60;

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function profileFile(): string {
  return path.resolve(serverRoot, appConfig.profilePath);
}

interface ProfileData {
  facts: string[];
}

/** 读取画像文件：不存在 / 损坏一律降级为空画像，不向调用方抛错 */
async function readProfile(): Promise<ProfileData> {
  try {
    const raw = await fsp.readFile(profileFile(), 'utf8');
    const data = JSON.parse(raw) as Partial<ProfileData>;
    return {
      facts: Array.isArray(data.facts)
        ? data.facts.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return { facts: [] };
  }
}

/** 临时文件 + rename 原子替换，避免写一半崩溃留下损坏 JSON */
async function writeProfile(data: ProfileData): Promise<void> {
  const file = profileFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** 读取全部长期记忆条目 */
export async function loadProfileFacts(): Promise<string[]> {
  return (await readProfile()).facts;
}

/** 追加条目（去重、截断超长、上限 30 条），返回追加后的总条数 */
export async function appendProfileFacts(facts: string[]): Promise<number> {
  const data = await readProfile();
  const clean = facts
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .map((f) => {
      const chars = Array.from(f);
      return chars.length > MAX_FACT_CHARS ? `${chars.slice(0, MAX_FACT_CHARS).join('')}…` : f;
    });
  const seen = new Set(data.facts);
  for (const f of clean) {
    if (!seen.has(f)) {
      data.facts.push(f);
      seen.add(f);
    }
  }
  if (data.facts.length > MAX_FACTS) {
    data.facts = data.facts.slice(data.facts.length - MAX_FACTS);
  }
  if (clean.length > 0) {
    await writeProfile(data);
  }
  return data.facts.length;
}

/** 清空全部长期记忆 */
export async function clearProfile(): Promise<void> {
  await writeProfile({ facts: [] });
}

/**
 * 用 LLM 从一段对话中提取用户的稳定信息（称呼、偏好、背景等）。
 * 返回条目数组（最多 5 条）；无可提取信息 / 失败时返回空数组（异常向调用方抛出，由调用方兜底）。
 */
export async function extractProfileFacts(
  adapter: ProviderAdapter,
  transcript: string
): Promise<string[]> {
  if (!adapter.isAvailable()) return [];
  // 独立 signal：提取在响应收尾后异步进行，不能挂到已结束的请求 signal 上
  const res = await adapter.chatStream(
    {
      provider: adapter.id,
      model: '',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '从对话中提取用户的稳定信息（称呼、职业、偏好、长期背景等），每行一条，以「用户」开头，每条不超过 40 字。只输出条目本身，不要编号与解释；没有可提取的信息时输出空内容。',
        },
        { role: 'user', content: transcript },
      ],
    },
    { onDelta: () => {} },
    new AbortController().signal
  );
  const text = res.text.trim();
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.replace(/^[-•*\d.\s]+/, '').trim())
    .filter((line) => line.length >= 2 && line.length <= 80)
    .slice(0, 5);
}
