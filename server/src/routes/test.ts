import { Router } from 'express';
import { getAdapterForUser } from '../providers';

export const testRouter = Router();

/** POST /api/test/:provider：最小连通性探测（max_tokens=8 的 chat 请求） */
testRouter.post('/:provider', async (req, res) => {
  const provider = req.params.provider;
  // 密钥解析：平台密钥 → 用户自有密钥（设置页「测试连接」探测的是当前用户生效密钥）
  const adapter = getAdapterForUser(provider, req.user?.id ?? '');
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
