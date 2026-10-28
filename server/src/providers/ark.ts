import type { ImageRequest } from '../../../shared/types';
import { providers } from '../config';
import { OpenAICompatProvider } from './base';

/** 火山方舟（豆包）：chat 兼容 OpenAI；图像增加 watermark 等私有参数 */
export class ArkProvider extends OpenAICompatProvider {
  constructor() {
    super(providers.ark);
  }

  protected override buildImagePayload(req: ImageRequest): Record<string, unknown> {
    return {
      model: req.model || this.cfg.imageModel,
      prompt: req.prompt,
      size: req.size ?? '1024x1024',
      response_format: 'url',
      watermark: false,
      n: req.count ?? 1,
    };
  }
}
