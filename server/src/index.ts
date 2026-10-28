import express from 'express';
import cors from 'cors';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PORT, providers, isProviderAvailable } from './config';
import { chatRouter } from './routes/chat';
import { embeddingsRouter } from './routes/embeddings';
import { imageRouter } from './routes/image';
import { kbRouter } from './routes/kb';
import { modelsRouter } from './routes/models';
import { testRouter } from './routes/test';
import { filesRouter } from './routes/files';
import { ttsRouter } from './routes/tts';
import { settingsRouter } from './routes/settings';
import { initProviderSettings } from './settingsConfig';
import { executeTool, listToolSchemas } from './tools';
import { clearProfile, loadProfileFacts } from './memory';

// 启动时拍 .env 基线并合并 settings.json 的用户修改（须在适配器首次使用前执行）
initProviderSettings();

const app = express();

app.use(cors());
// 上限 32mb：对话请求可能携带多张图片的 base64（视觉输入），知识库文档单篇 ≤ 2MB
app.use(express.json({ limit: '32mb' }));

/* AI 网关路由 */
app.use('/api/models', modelsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/image', imageRouter);
app.use('/api/embeddings', embeddingsRouter);
app.use('/api/kb', kbRouter);
app.use('/api/test', testRouter);
app.use('/api/files', filesRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/settings', settingsRouter);

/** GET /api/tools：内置工具注册表（ToolSchema 列表，可随 /api/chat 透传） */
app.get('/api/tools', (_req, res) => {
  res.json({ tools: listToolSchemas() });
});

/** POST /api/tools/execute：执行内置工具。body { name, arguments(JSON 字符串), confirmed? }
 *  写 / 高危工具必须带 confirmed=true（用户授权）才会真正执行 */
app.post('/api/tools/execute', (req, res) => {
  const body = req.body as { name?: unknown; arguments?: unknown; confirmed?: unknown } | undefined;
  if (!body || typeof body.name !== 'string' || typeof body.arguments !== 'string') {
    res
      .status(400)
      .json({ ok: false, error: '请求格式错误：需要 name（字符串）与 arguments（JSON 字符串）' });
    return;
  }
  void executeTool(body.name, body.arguments, body.confirmed === true).then((result) => {
    res.json(result);
  });
});

/** GET /api/memory：长期用户画像（对话记忆条目） */
app.get('/api/memory', (_req, res) => {
  void loadProfileFacts()
    .then((facts) => res.json({ facts }))
    .catch((err: unknown) =>
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    );
});

/** DELETE /api/memory：清空长期用户画像 */
app.delete('/api/memory', (_req, res) => {
  void clearProfile()
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) =>
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    );
});

/** 健康检查：返回各模型服务商可用性 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    providers: Object.fromEntries(
      Object.keys(providers).map((id) => [id, isProviderAvailable(id)])
    ),
  });
});

/**
 * 静态托管前端构建产物（桌面版 / 纯 Node 部署用）：
 * 设置 CLIENT_DIST_DIR 后，同一端口同源承载页面与 /api（免 CORS、免 Vite 代理）。
 * 放在所有 /api 路由之后注册，API 优先命中。
 */
const clientDist = process.env.CLIENT_DIST_DIR;
if (clientDist && existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  // SPA 回退：非 GET 与 /api 一律放行，其余路径回退 index.html（BrowserRouter 深链接）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[dra-agent-server] serving client dist at ${clientDist}`);
}

/**
 * 启动 HTTP 监听：端口被占（EADDRINUSE）时自动向上重试最多 10 个。
 * Windows 上 bind 探测可能因 SO_REUSEADDR 误判端口空闲，服务端自愈才是根治。
 */
function listenWithRetry(basePort: number): void {
  let attempt = 0;
  const tryListen = (): void => {
    const server = app.listen(basePort + attempt, () => {
      const port = basePort + attempt;
      // 桌面版：把最终端口写给主进程（监听端口可能与传入 PORT 不同——被占自愈时）
      if (process.env.PORT_FILE) {
        try {
          writeFileSync(process.env.PORT_FILE, String(port));
        } catch {
          // 主进程读不到文件时会走健康检查兜底
        }
      }
      console.log(`[dra-agent-server] listening at http://localhost:${port}`);
      const status = Object.keys(providers)
        .map((id) => `${id}:${isProviderAvailable(id) ? 'ok' : 'missing-key'}`)
        .join(' ');
      console.log(`[dra-agent-server] providers -> ${status}`);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        console.warn(`[dra-agent-server] port ${basePort + attempt} in use, trying next…`);
        attempt += 1;
        tryListen();
        return;
      }
      console.error(`[dra-agent-server] listen failed: ${err.message}`);
      process.exit(1);
    });
  };
  tryListen();
}

listenWithRetry(PORT);
