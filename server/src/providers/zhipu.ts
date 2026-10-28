import type { ImageRequest } from '../../../shared/types';
import { providers } from '../config';
import { OpenAICompatProvider } from './base';

/** 智谱 AI：chat / cogview 图像 / embedding-3 向量 */
export class ZhipuProvider extends OpenAICompatProvider {
  constructor() {
    super(providers.zhipu);
  }

  /** 智谱 /images/generations 仅接受 {model, prompt, size?}，不支持 n 与 response_format */
  protected override buildImagePayload(req: ImageRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: req.model || this.cfg.imageModel,
      prompt: req.prompt,
    };
    if (req.size) {
      payload.size = req.size;
    }
    return payload;
  }
}
