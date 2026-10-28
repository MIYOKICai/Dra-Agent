/**
 * Electron 主进程（CommonJS，避免受 package.json type 影响）。
 *
 * 职责：
 *  - 生产模式：从 resources/app 拉起 esbuild 打包的 server 单文件（ELECTRON_RUN_AS_NODE），
 *    数据目录全部重定向到 userData（可写），空闲端口探测后等待 /api/health 就绪，
 *    再加载 http://127.0.0.1:<port>/（server 静态托管 client-dist，同源免 CORS）
 *  - 开发模式（ELECTRON_DEV=1）：直接加载 Vite dev server（server 由 npm run dev 独立拉起）
 */
const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const isDev = process.env.ELECTRON_DEV === '1';

app.setName('Dra-Agent');

/** 单实例锁：重复启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/** 探测 127.0.0.1 上端口是否空闲 */
function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 从 start 起找第一个空闲端口（避开用户 dev server 占用 3001 的情况） */
async function pickPort(start, tries = 20) {
  for (let p = start; p < start + tries; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await checkPort(p)) return p;
  }
  throw new Error(`127.0.0.1 上 ${start} 起连续 ${tries} 个端口均被占用`);
}

/** 轮询等待 server 健康检查就绪 */
async function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 尚未就绪
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`server 启动超时：${url}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // 外部链接（如模型服务商文档）走系统浏览器，不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.loadURL(url);
  return win;
}

let mainWindow = null;
let serverProcess = null;

async function startProdServer() {
  // 打包后：resources/app/{server/server.cjs, client-dist}；未打包直跑：release/app 同构
  const baseDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..', 'release', 'app');
  const serverEntry = path.join(baseDir, 'server', 'server.cjs');
  const clientDistDir = path.join(baseDir, 'client-dist');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`未找到服务端产物：${serverEntry}`);
  }

  // 数据目录重定向到 userData（安装目录只读）：知识库 / 上传文件 / 设置 / 画像 / 敏感词表
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = await pickPort(3001);
  // GUI 进程无控制台，fork 的 stdio:'inherit' 会拿到无效句柄导致子进程静默失败；
  // 改用 spawn（ELECTRON_RUN_AS_NODE 把 Electron exe 当 Node 跑），输出写入日志文件便于排查。
  // server 若发现传入端口被占会自愈换端口，并把最终端口写入 PORT_FILE 供主进程读取
  const logPath = path.join(dataDir, 'server.log');
  const portFile = path.join(dataDir, 'server.port');
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    // 首次启动不存在
  }
  const logFd = fs.openSync(logPath, 'a');
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: path.dirname(serverEntry),
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      PORT_FILE: portFile,
      KB_DATA_DIR: path.join(dataDir, 'kb'),
      FILES_DATA_DIR: path.join(dataDir, 'files'),
      SETTINGS_PATH: path.join(dataDir, 'settings.json'),
      PROFILE_PATH: path.join(dataDir, 'profile.json'),
      SENSITIVE_WORDS_PATH: path.join(dataDir, 'sensitive-words.txt'),
      CLIENT_DIST_DIR: clientDistDir,
    },
  });
  fs.closeSync(logFd);
  serverProcess.on('exit', (code) => {
    console.log(`[dra-agent] server exited with code ${code}`);
  });
  app.on('before-quit', () => {
    if (serverProcess) {
      try {
        serverProcess.kill();
      } catch {
        // 已退出
      }
    }
  });

  // 等待 server 写出实际端口（可能与传入 PORT 不同），再等健康检查就绪
  const actualPort = await waitForPortFile(portFile, 20000);
  await waitForServer(`http://127.0.0.1:${actualPort}/api/health`);
  return `http://127.0.0.1:${actualPort}/`;
}

/** 轮询等待 server 落盘最终端口 */
async function waitForPortFile(file, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {
      // 尚未写出
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待 server 端口文件超时：${file}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    if (!isDev) {
      // 生产环境去掉默认菜单栏，界面更干净
      Menu.setApplicationMenu(null);
    }
    const url = isDev ? 'http://localhost:5173/' : await startProdServer();
    mainWindow = createWindow(url);
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Dra-Agent 启动失败', String(err instanceof Error ? err.message : err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
