import { Router } from 'express';
import type { ImageRequest } from '../../../shared/types';
import { getAdapter } from '../providers';
import { checkText } from '../safety';

export const imageRouter = Router();

/** 允许的尺寸白名单，非法值回退 1024x1024 */
const ALLOWED_SIZES = new Set([
  '512x512',
  '768x768',
  '1024x1024',
  '864x1152',
  '1152x864',
  '1440x720',
]);
const DEFAULT_SIZE = '1024x1024';
const MAX_COUNT = 4;

/** POST /api/image：图像生成，返回 { images: (url | dataURL)[] } */
imageRouter.post('/', async (req, res) => {
  const body = req.body as Partial<ImageRequest> | undefined;
  if (
    !body ||
    typeof body.provider !== 'string' ||
    typeof body.prompt !== 'string' ||
    !body.prompt.trim()
  ) {
    res.status(400).json({ error: '请求格式错误：需要 provider 与 prompt' });
    return;
  }
  const adapter = getAdapter(body.provider);
  if (!adapter) {
    res.status(404).json({ error: `未知服务商：${body.provider}` });
    return;
  }
  if (!adapter.isAvailable()) {
    res.status(400).json({ error: `服务商「${adapter.name}」未配置 API Key` });
    return;
  }

  const promptCheck = await checkText(body.prompt);
  if (promptCheck.blocked) {
    res.status(400).json({ blocked: true, hits: promptCheck.hits });
    return;
  }

  const size =
    typeof body.size === 'string' && ALLOWED_SIZES.has(body.size) ? body.size : DEFAULT_SIZE;
  const count = Math.min(Math.max(Math.trunc(Number(body.count ?? 1)) || 1, 1), MAX_COUNT);

  try {
    const started = Date.now();
    const images = await adapter.generateImage({
      provider: body.provider,
      model: typeof body.model === 'string' ? body.model : '',
      prompt: body.prompt,
      size,
      count,
    });
    // 图像链路排障关键日志：无论成功失败都留痕（provider/模型/张数/耗时）
    console.log(
      `[image] provider=${body.provider} model=${typeof body.model === 'string' ? body.model : '-'} ` +
        `count=${count} got=${images.length} ${Date.now() - started}ms prompt="${body.prompt.slice(0, 40)}"`
    );
    res.json({ images });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[image] provider=${body.provider} FAILED ${message.slice(0, 160)}`);
    res.status(502).json({ error: message });
  }
});
