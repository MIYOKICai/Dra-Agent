/**
 * Electron 主进程（CommonJS，避免受 package.json type 影响）。
 *
 * 职责：
 *  - 生产模式：从 resources/app 拉起 esbuild 打包的 server 单文件（ELECTRON_RUN_AS_NODE），
 *    数据目录全部重定向到 userData（可写），空闲端口探测后等待 /api/health 就绪，
 *    再加载 http://127.0.0.1:<port>/（server 静态托管 client-dist，同源免 CORS）
 *  - 开发模式（ELECTRON_DEV=1）：直接加载 Vite dev server（server 由 npm run dev 独立拉起）
 */
const { app, BrowserWindow, Menu, shell, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');

const isDev = process.env.ELECTRON_DEV === '1';

app.setName('Dra-Agent');

// 测试 / 多实例隔离：环境变量重定向 userData（默认 %APPDATA%/Dra-Agent，生产不受影响）
if (process.env.DRA_USER_DATA) {
  app.setPath('userData', process.env.DRA_USER_DATA);
}

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

/** 注册窗口控制 IPC：渲染进程经 preload 暴露的 draWindow 调用（不用废弃的 remote） */
function registerWindowIpc() {
  const fromEvent = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('dra:minimize', (e) => fromEvent(e)?.minimize());
  ipcMain.handle('dra:toggle-maximize', (e) => {
    const win = fromEvent(e);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });
  ipcMain.handle('dra:close', (e) => fromEvent(e)?.close());
  ipcMain.handle('dra:toggle-fullscreen', (e) => {
    const win = fromEvent(e);
    if (!win) return false;
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  ipcMain.handle('dra:is-fullscreen', (e) => Boolean(fromEvent(e)?.isFullScreen()));
}

/** 把窗口状态（最大化 / 全屏）变化广播给渲染进程（标题栏按钮图标切换用） */
function wireWindowStateBroadcast(win) {
  const send = () =>
    win.webContents.send('dra:window-state', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    });
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, send);
  }
}

/* ====== 专属本地数据保险库：userData/data/appstore 加密落盘 ======
 * 渲染层（画布 / 工作区等）原先只存 localStorage，而 localStorage 按「源」
 * （127.0.0.1:端口）分区——server 自愈换端口后源变化，用户保存的内容会整体
 * 「消失」。保险库与源无关，按 key 加密为独立文件，是真正的持久层：
 *   文件格式：magic(8B "DRVAULT1") + algo(1B: 1=DPAPI 2=AES-256-GCM) + 密文
 *   优先 DPAPI（safeStorage，绑定当前系统用户）；不可用时回退目录内随机密钥
 *   的 AES-256-GCM（store.key，0600）。写入均为 tmp + rename 原子替换。 */
const VAULT_MAGIC = Buffer.from('DRVAULT1', 'ascii');

function vaultDir() {
  return path.join(app.getPath('userData'), 'data', 'appstore');
}

/** key → 文件名：仅保留安全字符，其余转十六进制（本项目 key 均为 [a-z0-9-]） */
function vaultFileName(key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, (ch) =>
    ch.charCodeAt(0).toString(16).padStart(2, '0')
  );
  return `${safe}.bin`;
}

let aesKeyCache = null;

/** AES-256-GCM 回退密钥：目录内 store.key，首次随机生成 */
function vaultAesKey() {
  if (aesKeyCache) return aesKeyCache;
  fs.mkdirSync(vaultDir(), { recursive: true });
  const file = path.join(vaultDir(), 'store.key');
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 32) {
      aesKeyCache = raw;
      return aesKeyCache;
    }
  } catch {
    // 首次生成
  }
  aesKeyCache = crypto.randomBytes(32);
  fs.writeFileSync(file, aesKeyCache, { mode: 0o600 });
  return aesKeyCache;
}

function vaultEncrypt(plain) {
  const useDpapi = safeStorage.isEncryptionAvailable();
  const head = Buffer.concat([VAULT_MAGIC, Buffer.from([useDpapi ? 1 : 2])]);
  if (useDpapi) {
    return Buffer.concat([head, safeStorage.encryptString(plain)]);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultAesKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  return Buffer.concat([head, iv, cipher.getAuthTag(), body]);
}

function vaultDecrypt(buf) {
  if (buf.length <= VAULT_MAGIC.length + 1 || !buf.subarray(0, VAULT_MAGIC.length).equals(VAULT_MAGIC)) {
    throw new Error('文件头不识别');
  }
  const algo = buf[VAULT_MAGIC.length];
  const body = buf.subarray(VAULT_MAGIC.length + 1);
  if (algo === 1) return safeStorage.decryptString(body);
  if (algo === 2) {
    const iv = body.subarray(0, 12);
    const tag = body.subarray(12, 28);
    const data = body.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultAesKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  }
  throw new Error(`算法未知：${algo}`);
}

function vaultWrite(key, plain) {
  fs.mkdirSync(vaultDir(), { recursive: true });
  const file = path.join(vaultDir(), vaultFileName(key));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, vaultEncrypt(plain));
  fs.renameSync(tmp, file); // 原子替换：写一半崩溃不会留下坏文件
}

function vaultRead(key) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(vaultDir(), vaultFileName(key)));
  } catch {
    return null; // 不存在
  }
  try {
    return vaultDecrypt(buf);
  } catch (err) {
    // 解密失败（换机 / 密钥丢失 / 文件损坏）：备份坏文件按缺失处理，不让启动挂死
    const file = path.join(vaultDir(), vaultFileName(key));
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 忽略
    }
    console.warn(`[dra-agent] vault 读取失败 ${key}: ${err}`);
    return null;
  }
}

/** 注册渲染层持久化 IPC：loadAll 一次拉全量（启动引导），set/remove 单键读写 */
function registerVaultIpc() {
  ipcMain.handle('dra:store-load', () => {
    const out = {};
    let files = [];
    try {
      files = fs.readdirSync(vaultDir());
    } catch {
      return out; // 目录尚未创建
    }
    for (const name of files) {
      if (!name.endsWith('.bin')) continue;
      const plain = vaultRead(name.slice(0, -4));
      if (plain != null) out[name.slice(0, -4)] = plain;
    }
    return out;
  });
  ipcMain.handle('dra:store-set', (_e, key, value) => {
    if (typeof key !== 'string' || typeof value !== 'string' || !key) return false;
    try {
      vaultWrite(key, value);
      return true;
    } catch (err) {
      console.warn(`[dra-agent] vault 写入失败 ${key}: ${err}`);
      return false;
    }
  });
  ipcMain.handle('dra:store-remove', (_e, key) => {
    if (typeof key !== 'string') return false;
    try {
      fs.rmSync(path.join(vaultDir(), vaultFileName(key)), { force: true });
    } catch {
      // 忽略
    }
    return true;
  });
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // 无边框：由渲染进程 TitleBar 组件自绘标题栏（拖动 / 最小化 / 最大化 / 全屏 / 关闭）
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  wireWindowStateBroadcast(win);
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

  // 端口亲和：优先复用上次成功端口，减少「源」漂移（localStorage 按源分区，
  // 源变化 = 老数据看似消失；保险库落地后此机制仅作为旧版本升级的兼容兜底）
  const lastPortFile = path.join(dataDir, 'last-port');
  let startPort = 3001;
  try {
    const last = Number(fs.readFileSync(lastPortFile, 'utf-8').trim());
    if (Number.isInteger(last) && last > 0 && last < 65536) startPort = last;
  } catch {
    // 首次启动不存在
  }
  const port = (await checkPort(startPort)) ? startPort : await pickPort(3001);
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
  try {
    fs.writeFileSync(lastPortFile, String(actualPort));
  } catch {
    // 写不进去只影响下次端口亲和，不阻断启动
  }
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
    registerWindowIpc();
    registerVaultIpc(); // 加密保险库（safeStorage 需在 app ready 后使用）
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
