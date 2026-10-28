import fsp from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from './config';
import { serverRoot } from './paths';

/** 内置默认词库（词表文件不存在时用它创建文件） */
const DEFAULT_WORDS = ['赌博', '毒品', '枪支', '洗钱', '自杀方法', '诈骗', '邪教', '爆炸物'];

const DEFAULT_FILE_CONTENT = [
  '# 敏感词库：一行一词，# 开头为注释；修改保存后服务会自动重新加载',
  ...DEFAULT_WORDS,
  '',
].join('\n');

/** 解析词表文件绝对路径：绝对路径原样使用，相对路径以 server 目录为基准 */
function resolveWordsPath(): string {
  const configured = appConfig.sensitiveWordsPath;
  if (!configured) return '';
  return path.isAbsolute(configured) ? configured : path.resolve(serverRoot, configured);
}

let cache: { mtimeMs: number; words: string[] } | null = null;

/** 加载词库；文件不存在则用内置默认词库创建；mtime 变化时自动重新加载 */
async function loadWords(): Promise<string[]> {
  const file = resolveWordsPath();
  if (!file) return DEFAULT_WORDS;
  try {
    let stat = await fsp.stat(file).catch(() => null);
    if (!stat) {
      await fsp.writeFile(file, DEFAULT_FILE_CONTENT, 'utf8');
      stat = await fsp.stat(file);
    }
    if (cache && cache.mtimeMs === stat.mtimeMs) {
      return cache.words;
    }
    const raw = await fsp.readFile(file, 'utf8');
    const words = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((word) => word.length > 0);
    cache = { mtimeMs: stat.mtimeMs, words };
    return words;
  } catch {
    // 词表读取失败时兜底内置词库，保证拦截功能可用
    return DEFAULT_WORDS;
  }
}

export interface TextCheckResult {
  blocked: boolean;
  hits: string[];
}

/** 检查文本是否命中敏感词（大小写不敏感的包含匹配） */
export async function checkText(text: string): Promise<TextCheckResult> {
  if (!text) {
    return { blocked: false, hits: [] };
  }
  const words = await loadWords();
  const normalized = text.toLowerCase();
  const hits = words.filter((word) => normalized.includes(word.toLowerCase()));
  return { blocked: hits.length > 0, hits };
}
