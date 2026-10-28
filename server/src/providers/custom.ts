import { providers } from '../config';
import { OpenAICompatProvider } from './base';

/** 自定义 OpenAI 兼容接入：baseUrl / apiKey / 模型名全部来自环境变量 */
export class CustomProvider extends OpenAICompatProvider {
  constructor() {
    super(providers.custom);
  }

  override isAvailable(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.baseUrl);
  }
}
