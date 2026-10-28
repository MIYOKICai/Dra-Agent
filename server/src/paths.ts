/**
 * 服务端根目录（server/）定位：兼容双运行环境——
 * - ESM（tsx dev / node 直跑 dist）：用 import.meta.url 向上两级定位
 * - esbuild CJS 单文件 bundle（桌面版）：import.meta 在 CJS 产物中不存在，
 *   触发异常后回退 __filename（即 bundle 文件所在目录，主进程已把 cwd 指向这里）
 * 相对数据路径（kbDataDir / profilePath / sensitiveWordsPath…）一律以此为基准解析。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __filename: string; // 仅 CJS 产物存在；ESM 分支不会求值到它

export const serverRoot: string = (() => {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return path.dirname(path.dirname(__filename));
  }
})();
