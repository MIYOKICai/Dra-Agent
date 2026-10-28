import 'dotenv/config';
import type { ModelInfo } from '../../shared/types';

/** 单个模型服务商的接入配置（AI 网关统一读取） */
export interface ProviderConfig {
  id: string;
  /** 展示名称 */
  name: string;
  /** OpenAI 兼容 Base URL */
  baseUrl: string;
  /** API Key（来自环境变量，未配置时为 undefined） */
  apiKey?: string;
  /** 默认对话模型 */
  chatModel?: string;
  /** 默认图像生成模型 */
  imageModel?: string;
  /** 默认向量模型 */
  embeddingModel?: string;
  /** 服务商对外提供的模型清单 */
  models: ModelInfo[];
}

const env = process.env;

/** 服务监听端口 */
export const PORT = Number(env.PORT ?? 3001);

const arkChatModel = env.ARK_CHAT_MODEL ?? 'doubao-seed-1-6-flash-250815';
const arkImageModel = env.ARK_IMAGE_MODEL ?? 'doubao-seedream-5-0-flash-260915';
const zhipuChatModel = env.ZHIPU_CHAT_MODEL ?? 'glm-4-flash';
const zhipuImageModel = env.ZHIPU_IMAGE_MODEL ?? 'cogview-3-flash';
const zhipuEmbeddingModel = env.ZHIPU_EMBEDDING_MODEL ?? 'embedding-3';

/** 根据环境变量组装 custom 服务商的模型清单 */
function buildCustomModels(): ModelInfo[] {
  const models: ModelInfo[] = [];
  if (env.CUSTOM_CHAT_MODEL) {
    models.push({ id: env.CUSTOM_CHAT_MODEL, name: `${env.CUSTOM_CHAT_MODEL}（自定义对话）`, kind: ['chat'] });
  }
  if (env.CUSTOM_IMAGE_MODEL) {
    models.push({ id: env.CUSTOM_IMAGE_MODEL, name: `${env.CUSTOM_IMAGE_MODEL}（自定义绘图）`, kind: ['image'] });
  }
  return models;
}

/** 服务商接入配置：DeepSeek / 火山方舟（豆包）/ 智谱 / 自定义 / mock 演示 */
export const providers: Record<string, ProviderConfig> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: env.DEEPSEEK_API_KEY,
    chatModel: 'deepseek-chat',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat（V3）', kind: ['chat'] }],
  },
  ark: {
    id: 'ark',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: env.ARK_API_KEY,
    chatModel: arkChatModel,
    imageModel: arkImageModel,
    // 模型清单仅来自 .env 配置项（ARK_CHAT_MODEL / ARK_IMAGE_MODEL），不再硬编码额外型号；
    // 与内置默认值一致时显示友好名，自定义值直接展示模型 id
    models: [
      {
        id: arkChatModel,
        name: arkChatModel === 'doubao-seed-1-6-flash-250815' ? '豆包 Seed 1.6 Flash' : arkChatModel,
        kind: ['chat'],
        // 豆包 Seed 系列对话模型均支持视觉输入（看图）
        vision: true,
      },
      {
        id: arkImageModel,
        name:
          arkImageModel === 'doubao-seedream-5-0-flash-260915' ? 'Seedream 5.0 Flash' : arkImageModel,
        kind: ['image'],
      },
    ],
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: env.ZHIPU_API_KEY,
    chatModel: zhipuChatModel,
    imageModel: zhipuImageModel,
    embeddingModel: zhipuEmbeddingModel,
    models: [
      { id: zhipuChatModel, name: 'GLM-4-Flash', kind: ['chat'] },
      { id: zhipuImageModel, name: 'CogView-3-Flash', kind: ['image'] },
      { id: zhipuEmbeddingModel, name: 'Embedding-3', kind: ['embedding'] },
    ],
  },
  custom: {
    id: 'custom',
    name: '自定义接入',
    baseUrl: env.CUSTOM_BASE_URL ?? '',
    apiKey: env.CUSTOM_API_KEY,
    chatModel: env.CUSTOM_CHAT_MODEL,
    imageModel: env.CUSTOM_IMAGE_MODEL,
    models: buildCustomModels(),
  },
  mock: {
    id: 'mock',
    name: '演示模式',
    baseUrl: '',
    models: [
      { id: 'mock-chat', name: '演示对话模型', kind: ['chat'] },
      { id: 'mock-image', name: '演示绘图模型', kind: ['image'] },
      { id: 'mock-embedding', name: '演示向量模型', kind: ['embedding'] },
    ],
  },
};

/** 应用级路径配置 */
export const appConfig = {
  /**
   * 敏感词表路径。相对路径以 server 目录为基准；
   * 文件不存在时会用内置默认词库自动创建。
   */
  sensitiveWordsPath: env.SENSITIVE_WORDS_PATH ?? 'sensitive-words.txt',
  /** 知识库数据目录 */
  kbDataDir: env.KB_DATA_DIR ?? './data/kb',
  /** 画布文件上传节点的存储目录（原始字节 + 提取文本） */
  filesDataDir: env.FILES_DATA_DIR ?? './data/files',
  /** 设置页服务商配置落盘文件（.env 之外的运行时可写覆盖层） */
  settingsPath: env.SETTINGS_PATH ?? './data/settings.json',
  /** 长期用户画像（对话记忆）落盘文件 */
  profilePath: env.PROFILE_PATH ?? './data/profile.json',
};

/** 判断服务商是否可用：已配置 API Key；custom 还必须配置了 baseUrl；mock 始终可用 */
export function isProviderAvailable(id: string): boolean {
  if (id === 'mock') {
    return true;
  }
  const p = providers[id];
  if (!p) {
    return false;
  }
  if (id === 'custom') {
    return Boolean(p.apiKey && p.baseUrl);
  }
  return Boolean(p.apiKey);
}
