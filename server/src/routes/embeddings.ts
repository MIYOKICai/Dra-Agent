import { Router } from 'express';
import { getAdapterForUser } from '../providers';

export const embeddingsRouter = Router();

/** POST /api/embeddings：批量向量化，body { provider, model?, input: string | string[] } */
embeddingsRouter.post('/', async (req, res) => {
  const body = req.body as { provider?: string; model?: string; input?: unknown } | undefined;
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const rawInput = body?.input;
  const input = Array.isArray(rawInput) ? rawInput : typeof rawInput === 'string' ? [rawInput] : [];

  if (
    !provider ||
    input.length === 0 ||
    !input.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    res
      .status(400)
      .json({ error: '请求格式错误：需要 provider 与非空 input（字符串或字符串数组）' });
    return;
  }

  // requireAuth 在挂载点统一注入：密钥解析 平台密钥 → 用户自有密钥
  const adapter = getAdapterForUser(provider, req.user?.id ?? '');
  if (!adapter) {
    res.status(404).json({ error: `未知服务商：${provider}` });
    return;
  }
  if (!adapter.isAvailable()) {
    res.status(400).json({ error: `服务商「${adapter.name}」未配置 API Key` });
    return;
  }

  try {
    const embeddings = await adapter.embed(input as string[], {
      model: typeof body?.model === 'string' ? body.model : undefined,
    });
    res.json({ embeddings });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
