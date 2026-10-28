import { Router } from 'express';
import { getAdapter } from '../providers';

export const testRouter = Router();

/** POST /api/test/:provider：最小连通性探测（max_tokens=8 的 chat 请求） */
testRouter.post('/:provider', async (req, res) => {
  const provider = req.params.provider;
  const adapter = getAdapter(provider);
  if (!adapter) {
    res.status(404).json({ ok: false, error: `未知服务商：${provider}` });
    return;
  }
  if (!adapter.isAvailable()) {
    res.json({ ok: false, error: '未配置 API Key' });
    return;
  }
  const result = await adapter.probe();
  res.json(result);
});
