import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PORT, providers, isProviderAvailable } from './config';
import { runMigrations } from './db/migrate';
import { chatRouter } from './routes/chat';
import { embeddingsRouter } from './routes/embeddings';
import { imageRouter } from './routes/image';
import { kbRouter } from './routes/kb';
import { modelsRouter } from './routes/models';
import { testRouter } from './routes/test';
import { filesRouter } from './routes/files';
import { ttsRouter } from './routes/tts';
import { settingsRouter } from './routes/settings';
import { authRouter } from './routes/auth';
import { canvasesRouter } from './routes/canvases';
import { sessionsRouter } from './routes/sessions';
import { profileRouter } from './routes/profile';
import { userSettingsRouter } from './routes/userSettings';
import { moderationRouter } from './routes/moderation';
import { adminRouter } from './routes/admin';
import { initProviderSettings } from './settingsConfig';
import { executeTool, listToolSchemas } from './tools';
import { clearProfile, loadProfileFacts } from './memory';
import { requireAuth } from './middleware/auth';

// 启动时拍 .env 基线并合并 settings.json 的用户修改（须在适配器首次使用前执行）
initProviderSettings();

// 启动时执行数据库迁移（幂等，已应用的版本自动跳过）；建表失败直接终止启动
try {
  runMigrations();
} catch (err) {
  console.error('[dra-agent-server] 数据库迁移失败，终止启动:', err);
  process.exit(1);
}

const app = express();

/* Nginx 反代场景：信任第一层代理的 X-Forwarded-For，否则限流按回源 IP 计数，
 * 全站用户共享同一个 300/min 配额。直连部署时无该头，不影响取值。 */
app.set('trust proxy', 1);

/* 安全响应头：CSP 默认禁用 —— client dev 走 vite 代理同源、生产同源静态托管，
 * 而页面内联样式与画布 iframe 预览依赖宽松策略，默认 CSP 会破坏其加载；生产同源下
 * 无跨站脚本注入面，其余 helmet 默认头（HSTS/X-Frame-Options 等）照常生效 */
app.use(helmet({ contentSecurityPolicy: false }));

/* CORS 白名单：.env DRA_CORS_ORIGINS（逗号分隔），缺省含 vite dev 两个源；
 * Electron 桌面端与生产同源部署不带 Origin，无需配置。白名单外来源不下发 CORS 头
 * （浏览器侧拒绝跨域响应；生产要求同源部署，跨域仅开发用）。不开 credentials。 */
const corsOrigins = (process.env.DRA_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      // 无 Origin 头（curl / 同源 / Electron）放行；白名单外 origin 回 false = 不下发 CORS 头
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
  })
);

/* 分级限流：/api 全局 300 次/分/IP（admin 路由内部已有独立的 100 次/分、
 * auth 已有注册/登录限流，不在此重复挂） */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  },
});
app.use('/api', apiLimiter);

// 上限 32mb：对话请求可能携带多张图片的 base64（视觉输入），知识库文档单篇 ≤ 2MB
app.use(express.json({ limit: '32mb' }));

/* AI 网关路由（存量业务路由统一挂 requireAuth；kb / chat 路由内部已挂） */
app.use('/api/models', requireAuth, modelsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/image', requireAuth, imageRouter);
app.use('/api/embeddings', requireAuth, embeddingsRouter);
app.use('/api/kb', kbRouter);
app.use('/api/test', requireAuth, testRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/tts', requireAuth, ttsRouter);
app.use('/api/settings', requireAuth, settingsRouter);
/* 认证路由：注册 / 登录 / 刷新 / 登出 / 当前用户（密码 argon2id + 双 token 轮换） */
app.use('/api/auth', authRouter);
/* 用户上云数据：画布 / 会话 / 画像 / 个性化设置（路由内部均挂 requireAuth） */
app.use('/api/canvases', canvasesRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/user-settings', userSettingsRouter);
/* 内容治理：POST /api/reports（举报入口，路由内部挂 requireAuth） */
app.use('/api', moderationRouter);
/* 管理后台（requireAuth + requireAdmin + 独立限流 100 次/分，均在路由内部） */
app.use('/api/admin', adminRouter);

/** GET /api/tools：内置工具注册表（ToolSchema 列表，可随 /api/chat 透传） */
app.get('/api/tools', (_req, res) => {
  res.json({ tools: listToolSchemas() });
});

/** POST /api/tools/execute：执行内置工具。body { name, arguments(JSON 字符串), confirmed? }
 *  写 / 高危工具必须带 confirmed=true（用户授权）才会真正执行；需登录（知识库类工具按 req.user.id 隔离） */
app.post('/api/tools/execute', requireAuth, (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ ok: false, error: '未登录' });
    return;
  }
  const body = req.body as { name?: unknown; arguments?: unknown; confirmed?: unknown } | undefined;
  if (!body || typeof body.name !== 'string' || typeof body.arguments !== 'string') {
    res
      .status(400)
      .json({ ok: false, error: '请求格式错误：需要 name（字符串）与 arguments（JSON 字符串）' });
    return;
  }
  void executeTool(body.name, body.arguments, body.confirmed === true, { userId }).then((result) => {
    res.json(result);
  });
});

/** GET /api/memory：长期用户画像（对话记忆条目；旧版单文件存储，需登录读取） */
app.get('/api/memory', requireAuth, (_req, res) => {
  void loadProfileFacts()
    .then((facts) => res.json({ facts }))
    .catch((err: unknown) =>
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    );
});

/** DELETE /api/memory：清空长期用户画像 */
app.delete('/api/memory', requireAuth, (_req, res) => {
  void clearProfile()
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) =>
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    );
});

/** 健康检查：返回各模型服务商可用性（无敏感信息，保持公开供探活） */
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

/** 404 兜底：所有未匹配路径（含 /api 未定义端点）统一 JSON 响应 */
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

/** 统一错误处理：JSON { error }（body-parser 4xx 按其状态码，其余按 500） */
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = (err as { status?: unknown; statusCode?: unknown });
    const code =
      typeof status?.status === 'number'
        ? status.status
        : typeof status?.statusCode === 'number'
          ? status.statusCode
          : 500;
    const safeCode = code >= 400 && code <= 599 ? code : 500;
    if (safeCode >= 500) {
      console.error('[dra-agent-server] 未处理错误:', err);
    }
    res.status(safeCode).json({
      error: err instanceof Error && err.message ? err.message : '服务器内部错误',
    });
  }
);

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
