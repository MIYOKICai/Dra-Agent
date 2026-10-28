import { providers } from '../config';
import { OpenAICompatProvider } from './base';

/** DeepSeek：OpenAI 兼容的 chat/completions（stream + function calling） */
export class DeepSeekProvider extends OpenAICompatProvider {
  constructor() {
    super(providers.deepseek);
  }
}
