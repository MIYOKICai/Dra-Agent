# Dra-Agent 服务端部署指南（Linux · 商业化多用户版）

> **适用版本：v0.2.0+**（monorepo 根 `package.json` 版本号）。
> 本文档面向在 **Linux 服务器**上部署 Web 版（Node + SQLite 多用户商业化版本），所有命令均可直接复制执行。
> 桌面版（Windows / Electron）不在本文范围，仅需一句：`npm run electron:build` 产出 Windows 安装包（见 `electron-builder.yml`），桌面版与 Web 版复用同一套 server 代码。

下文以部署目录 `/opt/dra-agent`、域名 `example.com` 为例，请按实际情况替换。

---

## 1. 架构总览

```
用户浏览器 ──HTTPS──> Nginx(443) ──HTTP──> Node server(127.0.0.1:3001)
                                             │
                                             ├─ /api/*      Express API 网关（认证 / 限流 / SSE 流式对话）
                                             └─ /*          静态托管 client/dist（SPA 回退，与 API 同源）
                                             │
                                             └─ server/data/
                                                  ├─ dra-agent.db          SQLite 数据库（WAL 模式，单文件）
                                                  ├─ dra-agent.db-wal/-shm WAL 伴随文件
                                                  ├─ master.key            AES-256-GCM 主密钥（未配置时自动生成）
                                                  ├─ jwt.secret            JWT 签名密钥（未配置时自动生成）
                                                  ├─ settings.json         服务商配置运行时覆盖层
                                                  ├─ profile.json          长期用户画像
                                                  └─ files/<userId>/       用户上传文件与知识库文档
```

关键设计（决定部署方式）：

- **同源静态托管**：server 内置静态托管能力，设置环境变量 `CLIENT_DIST_DIR` 指向 `client/dist` 后，**同一端口同源承载页面与 API**（免 CORS、免 Vite 代理），SPA 深链接回退已内建。生产推荐此模式。
- **SQLite 单文件数据库**：位于 `<数据目录>/dra-agent.db`，WAL 模式，无外部数据库依赖。
- **端口 3001 可配置**：环境变量 `PORT`，默认 3001。端口被占时服务端会自动向上重试最多 10 个（3001→3011）——**生产环境务必显式固定 `PORT=3001`**，否则 Nginx 可能代理到错误实例。
- **对话为 SSE 流式**：Nginx 必须关闭缓冲（见第 7 章），不涉及 WebSocket。
- **密钥加密落库**：用户/平台在管理后台配置的各服务商 API Key，统一经 AES-256-GCM（主密钥 `master.key`）加密后存入 SQLite，明文不落盘。

## 2. 服务器要求

| 项目 | 要求 |
|---|---|
| 操作系统 | 推荐 Debian 12 / Ubuntu 22.04+（以下命令以此为准）；RHEL 系（Rocky/Alma 9+）同理，包管理命令替换为 dnf |
| Node.js | **≥ 20**（推荐 22 LTS）。项目未声明 `engines`，但依赖（better-sqlite3 13、Vite 5、tsx 4）要求 Node 20+ |
| CPU / 内存 | 2 核 4GB 起（argon2 密码哈希与 better-sqlite3 均为原生模块，单进程架构下 2C4G 可支撑数十并发用户） |
| 磁盘 | 20GB 起（SQLite 增长缓慢；知识库文档与上传文件存放于 `server/data/files/`，按业务量预估） |
| 网络 | 需能访问各 LLM 服务商 API（DeepSeek / 火山方舟 / 智谱或自定义 OpenAI 兼容端点）；防火墙只放行 80/443 |
| 软件依赖 | git、Nginx、（可选）sqlite3、pm2 或 systemd（二选一做进程守护）；better-sqlite3 / argon2 在主流 Linux x64/arm64 上会自动下载预编译二进制，一般**无需**编译工具链，若下载失败需安装 `python3 make g++` |

安装 Node 22 LTS（Debian/Ubuntu，NodeSource）：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx
node -v   # 应 ≥ v22.x
```

## 3. 获取代码与安装

```bash
# 1. 创建部署目录并拉取代码（替换为你的仓库地址）
sudo mkdir -p /opt/dra-agent && sudo chown $USER /opt/dra-agent
git clone <REPO_URL> /opt/dra-agent
cd /opt/dra-agent

# 2. 安装全部依赖（根 + client + server 一次完成）
npm run install:all
# 等价于：npm install && npm --prefix client install && npm --prefix server install

# 3. 构建前端（产物在 client/dist，TypeScript 编译 + Vite 打包）
npm run build:client

# 4. 编译服务端（产物在 server/dist，生产以 node dist/index.js 运行）
npm run build:server
```

> 生产运行使用编译产物（`server/dist`），不要用 `npm run dev`（tsx watch 是开发模式）。

## 4. 配置（.env）

server 通过 `dotenv` 加载 **`server/.env`**（相对进程工作目录解析，因此**进程 cwd 必须是 `server/` 目录**，第 6 章的 pm2 / systemd 配置均已保证）。`.env` 已被 `.gitignore` 忽略，需要手动创建：

```bash
cd /opt/dra-agent/server
cp .env.example .env
chmod 600 .env
```

生成两个关键密钥并写入 `.env`：

```bash
# 各执行一次，分别填入 DRA_MASTER_KEY 与 DRA_JWT_SECRET
openssl rand -base64 32
```

### 环境变量全表

| 变量名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DRA_JWT_SECRET` | **强烈建议** | 未配置时首次启动自动生成 `<数据目录>/jwt.secret`（日志有警告） | JWT 签名密钥。显式配置便于密钥管理与多实例一致；自动生成的文件请纳入备份 |
| `DRA_MASTER_KEY` | **强烈建议** | 未配置时首次启动自动生成 `<数据目录>/master.key` | AES-256-GCM 主密钥（base64 的 32 字节），用于加密平台 API Key 等敏感数据。**丢失将无法解密已存储的密钥，务必备份** |
| `PORT` | 建议 | `3001` | 服务监听端口。生产显式固定，避免端口占用时自动偏移导致 Nginx 代理错位 |
| `CLIENT_DIST_DIR` | **生产必填** | 无（未设置则不托管前端） | 指向 client 构建产物目录，如 `/opt/dra-agent/client/dist`。设置后同端口同源托管页面与 API |
| `DRA_DATA_DIR` | 否 | `server/data` | 服务端持久化数据目录（SQLite / master.key / jwt.secret 等）。默认已满足；如需自定义传绝对路径 |
| `DRA_CORS_ORIGINS` | 否 | `http://localhost:5173,http://127.0.0.1:5173` | CORS 白名单（逗号分隔）。**生产同源部署无需配置**——同源与 curl 请求不带 Origin 头，服务端直接放行；白名单仅用于开发期跨域调试 |
| `DEEPSEEK_API_KEY` | 可选 | 无 | DeepSeek 平台密钥（https://platform.deepseek.com）。也可部署后在管理后台配置（推荐，加密落库） |
| `ARK_API_KEY` | 可选 | 无 | 火山方舟（豆包）密钥（https://console.volcengine.com/ark） |
| `ARK_CHAT_MODEL` | 否 | `doubao-seed-1-6-flash-250815` | 火山方舟对话模型 |
| `ARK_IMAGE_MODEL` | 否 | `doubao-seedream-5-0-flash-260915` | 火山方舟图像生成模型 |
| `ZHIPU_API_KEY` | 可选 | 无 | 智谱 AI 密钥（https://open.bigmodel.cn） |
| `ZHIPU_CHAT_MODEL` | 否 | `glm-4-flash` | 智谱对话模型 |
| `ZHIPU_IMAGE_MODEL` | 否 | `cogview-3-flash` | 智谱图像模型 |
| `ZHIPU_EMBEDDING_MODEL` | 否 | `embedding-3` | 智谱向量模型 |
| `CUSTOM_BASE_URL` | 可选 | 无 | 自定义 OpenAI 兼容服务商 Base URL（如 `https://your-host/v1`） |
| `CUSTOM_API_KEY` | 可选 | 无 | 自定义服务商 API Key |
| `CUSTOM_CHAT_MODEL` | 可选 | 无 | 自定义对话模型名 |
| `CUSTOM_IMAGE_MODEL` | 可选 | 无 | 自定义图像模型名 |
| `SENSITIVE_WORDS_PATH` | 否 | `server/sensitive-words.txt`（相对 server 目录解析） | 敏感词表；文件不存在时用内置词库自动创建 |
| `KB_DATA_DIR` | 否 | `server/data/kb` | 变量仍在 `.env.example` 与代码中保留，但当前知识库实际存储路径为 `<数据目录>/files/<userId>/`（按用户隔离），此变量暂不影响实际落盘位置 |

> 高级路径覆盖（一般无需改动）：`FILES_DATA_DIR`（默认 `./data/files`）、`SETTINGS_PATH`（默认 `./data/settings.json`）、`PROFILE_PATH`（默认 `./data/profile.json`），相对路径以进程 cwd（即 `server/`）为基准解析。

生产环境最小配置示例（LLM 密钥推荐登录管理后台配置，此处 `.env` 可全部留空）：

```ini
PORT=3001
CLIENT_DIST_DIR=/opt/dra-agent/client/dist
DRA_JWT_SECRET=<openssl rand -base64 32 的输出>
DRA_MASTER_KEY=<openssl rand -base64 32 的输出>
```

## 5. 数据库初始化

```bash
cd /opt/dra-agent
npm --prefix server run migrate
```

- 迁移器幂等：版本记录写在库内 `_migrations` 表，已应用的版本自动跳过，**重复运行无副作用**，可放心在每次升级后执行。
- 实际上 **server 启动时也会自动执行迁移**（迁移失败会直接终止启动并打印原因），手动执行仅用于提前暴露问题。
- 数据库文件位置：`server/data/dra-agent.db`（`DRA_DATA_DIR` 未覆盖时）。数据目录不存在会自动创建，请确保运行用户对其有写权限。

## 6. 启动与进程守护

生产启动命令（等价于 `server` 包的 `start` script，即 `node dist/index.js`）：

```bash
cd /opt/dra-agent/server
node dist/index.js
```

看到 `[dra-agent-server] listening at http://localhost:3001` 与 `providers -> ...` 日志即启动成功（providers 行会标注各服务商 `ok` / `missing-key`）。

### 方式一：pm2（推荐，操作简单）

```bash
sudo npm install -g pm2
```

创建 `/opt/dra-agent/server/ecosystem.config.js`：

```js
module.exports = {
  apps: [
    {
      name: 'dra-agent',
      cwd: '/opt/dra-agent/server',       // 必须是 server/ 目录（.env 按相对路径加载）
      script: 'dist/index.js',
      instances: 1,                        // SQLite 单写者，保持单实例
      autorestart: true,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        CLIENT_DIST_DIR: '/opt/dra-agent/client/dist',
      },
      out_file: '/var/log/dra-agent.out.log',
      error_file: '/var/log/dra-agent.err.log',
    },
  ],
};
```

启动并设置开机自启：

```bash
cd /opt/dra-agent/server
pm2 start ecosystem.config.js
pm2 save
pm2 startup          # 按输出提示执行给出的 sudo 命令
```

常用命令：`pm2 logs dra-agent`（看日志）、`pm2 restart dra-agent`（重启）、`pm2 status`。

### 方式二：systemd（系统原生）

创建 `/etc/systemd/system/dra-agent.service`：

```ini
[Unit]
Description=Dra-Agent server (Node + SQLite)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/dra-agent/server
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=CLIENT_DIST_DIR=/opt/dra-agent/client/dist
EnvironmentFile=/opt/dra-agent/server/.env
Restart=on-failure
RestartSec=3
# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/dra-agent

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
# 运行用户需要整个目录树的可读权限与 data 的可写权限；统一归 www-data 最省心
sudo chown -R www-data:www-data /opt/dra-agent
sudo systemctl daemon-reload
sudo systemctl enable --now dra-agent
sudo systemctl status dra-agent
journalctl -u dra-agent -f    # 跟踪日志
```

> 采用 systemd 时，后续的 `git pull` / 构建 / `migrate` / 导入等运维命令请以 `sudo -u www-data` 执行（或干脆用 `sudo su - www-data -s /bin/bash` 切换后再操作），否则普通用户写不进 `server/data` 会报权限错误。

## 7. Nginx 反向代理（HTTPS + SSE）

先申请证书（Let's Encrypt / certbot，会自动改写 Nginx 配置）：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
# 先确保 80 端口的 server 块已存在且 server_name 正确，再执行：
sudo certbot --nginx -d example.com
```

完整 server 块示例（`/etc/nginx/sites-available/dra-agent`，软链到 `sites-enabled`；certbot 执行后 SSL 配置会被自动补全，也可直接使用下面的手工版本）：

```nginx
# HTTP 全部跳转 HTTPS
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;                              # Nginx ≥ 1.25.1；旧版本改写为 "listen 443 ssl http2;"
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # 与服务端 JSON body 上限对齐（服务端为 32mb，视觉输入 base64 较大）
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';    # 保持长连接（SSE 必需）

        # ---- SSE（流式对话）关键配置 ----
        # 不涉及 WebSocket：对话走 HTTP SSE，无需 upgrade 头
        proxy_buffering off;               # 关闭缓冲，否则流式输出会整段卡住后才一次性到达
        proxy_cache off;
        proxy_read_timeout 3600s;          # 长回答 / 工具调用链路耗时长，放宽读超时
        proxy_send_timeout 3600s;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/dra-agent /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

验证：

```bash
curl -s https://example.com/api/health
# 期望输出：{"ok":true,"providers":{...}}
curl -sI https://example.com/ | head -n 1
# 期望输出：HTTP/2 200
```

## 8. 首个管理员

- **首个注册用户自动成为 admin**（`POST /api/auth/register` 内部判定：用户表为空时新用户角色为 `admin`，之后注册的均为 `user`）。
- 流程：浏览器打开 `https://example.com` → 注册（邮箱 + 密码，argon2id 存储）→ 注册即登录。
- 注册后**立即进入管理后台**，在平台密钥页配置 DeepSeek / 火山方舟 / 智谱等各平台 API Key（经主密钥加密后落库；`.env` 中的同名变量可作为兜底）。密钥配齐后 `/api/health` 中对应服务商显示 `ok`。
- 管理后台同时提供用户管理（封禁 / 解封 / 限流策略）与审计日志查询。

## 9. 数据迁移与导入（旧版单用户数据）

若存在旧版单用户服务器数据（`<dir>/kb/<kbId>/index.json` 知识库索引 + `<dir>/profile.json` 长期画像），先完成第 8 章注册得到目标用户，再执行导入：

```bash
cd /opt/dra-agent

# 指定旧数据目录与目标用户邮箱
npm --prefix server run import-legacy -- --dir /path/to/legacy-data --email admin@example.com

# 均可省略：--dir 默认 server/data；--email 默认取最早创建的 admin 用户
npm --prefix server run import-legacy
```

导入行为：

- **知识库**：整个 `<kbId>/` 目录复制到 `<数据目录>/files/<userId>/<kbId>/`，并写入归属与文档元数据；向量随 `index.json` 原样携带（维度不一致时检索自动退化为关键词模式，安全无害）。
- **画像**：旧 `profile.json` 的 facts 与该用户已有画像合并去重后写回。
- **幂等**：重复执行时已导入的知识库整库跳过，元数据用 `INSERT OR IGNORE`，可放心重跑。
- 旧目录不存在或无旧版数据时打印提示并正常退出（exit 0）。

## 10. 备份与恢复

需要备份的内容：`server/data/dra-agent.db`（含 WAL）与 `server/data/files/`（用户上传与知识库文档），以及 `master.key` / `jwt.secret`（若用自动生成文件）与 `.env`。

### 方式一：cron + sqlite3 .backup（简单可靠）

安装：`sudo apt-get install -y sqlite3`。创建 `/opt/dra-agent/scripts/backup.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
DATA_DIR=/opt/dra-agent/server/data
BACKUP_DIR=/opt/dra-backups
STAMP=$(date +%F-%H%M)
mkdir -p "$BACKUP_DIR/files"

# SQLite 在线一致性快照（WAL 模式下必须用 .backup，禁止直接 cp 热库文件）
sqlite3 "$DATA_DIR/dra-agent.db" ".backup '$BACKUP_DIR/dra-agent-$STAMP.db'"
gzip -f "$BACKUP_DIR/dra-agent-$STAMP.db"

# 用户文件（上传 + 知识库文档）
rsync -a --delete "$DATA_DIR/files/" "$BACKUP_DIR/files/"

# 密钥文件（存在才拷）
cp -f "$DATA_DIR"/master.key "$BACKUP_DIR/" 2>/dev/null || true
cp -f "$DATA_DIR"/jwt.secret "$BACKUP_DIR/" 2>/dev/null || true

# 保留 14 天
find "$BACKUP_DIR" -maxdepth 1 -name 'dra-agent-*.db.gz' -mtime +14 -delete
```

```bash
chmod 700 /opt/dra-agent/scripts/backup.sh
# 每日 03:00 备份（建议装到 root 的 crontab：sudo crontab -e，避免运行用户读不到 data / 写不进备份目录）
sudo crontab -l 2>/dev/null | { cat; echo "0 3 * * * /opt/dra-agent/scripts/backup.sh >> /var/log/dra-backup.log 2>&1"; } | sudo crontab -
```

### 方式二：litestream（实时复制到对象存储，推荐生产）

安装 litestream 后创建 `/etc/litestream.yml`：

```yaml
dbs:
  - path: /opt/dra-agent/server/data/dra-agent.db
    replicas:
      - type: s3
        bucket: your-bucket
        path: dra-agent
        region: ap-southeast-1
        endpoint: https://s3.example.com   # 兼容 S3 的对象存储可自定义 endpoint
        # access-key-id / secret-access-key 建议通过环境变量 LITESTREAM_ACCESS_KEY_ID 等注入
```

`systemctl enable --now litestream`（litestream 会自动以复制模式感知 WAL，无需停机）。恢复用 `litestream restore -o /opt/dra-agent/server/data/dra-agent.db s3://your-bucket/dra-agent`。

### 恢复步骤

```bash
sudo systemctl stop dra-agent            # 或 pm2 stop dra-agent
# 1) 还原数据库：用备份的 .db（或 .db.gz 解压）覆盖 server/data/dra-agent.db，
#    并删除旧的 dra-agent.db-wal / dra-agent.db-shm（旧 WAL 与新库不一致会导致损坏）
gunzip -c /opt/dra-backups/dra-agent-2026-10-31-0300.db.gz > /opt/dra-agent/server/data/dra-agent.db
rm -f /opt/dra-agent/server/data/dra-agent.db-wal /opt/dra-agent/server/data/dra-agent.db-shm
# 2) 还原用户文件
rsync -a /opt/dra-backups/files/ /opt/dra-agent/server/data/files/
# 3) 还原 master.key / jwt.secret（若丢失，已加密的 API Key 将无法解密，需在管理后台重新配置）
# 4) 启动并验证
sudo systemctl start dra-agent
curl -s https://example.com/api/health
```

## 11. 升级流程

```bash
cd /opt/dra-agent

# 0) （稳妥起见）先备份，见第 10 章
/opt/dra-agent/scripts/backup.sh

# 1) 拉取新代码
git pull

# 2) 依赖有变更则重装（无变更时跳过）
npm run install:all

# 3) 重新构建前端与服务端
npm run build:client
npm run build:server

# 4) 对比环境变量示例，补充新增变量（如有）
diff server/.env.example server/.env || true

# 5) 执行迁移（幂等；服务启动时也会自动执行，此步用于提前暴露问题）
npm --prefix server run migrate
# systemd（www-data 运行）场景请改用：sudo -u www-data npm --prefix server run migrate

# 6) 重启进程
pm2 restart dra-agent          # 或：sudo systemctl restart dra-agent

# 7) 验证
curl -s https://example.com/api/health
```

## 12. 安全清单

- [ ] **防火墙只开 80/443，不暴露 3001**：
  ```bash
  sudo ufw default deny incoming && sudo ufw allow 22,80,443/tcp && sudo ufw enable
  ```
  Node 仅监听本机可达端口，Nginx 反代走 127.0.0.1；切勿在 Nginx 之外的层面暴露 3001。
- [ ] **HTTPS 强制**：HTTP 301 跳转 HTTPS（第 7 章配置已含）；certbot 自动续期已随包安装（`systemctl status certbot.timer` 确认）。
- [ ] **敏感文件权限与版本控制**：`server/.env`、`server/data/master.key`、`server/data/jwt.secret` 权限 600，属主为运行用户；三者均已被 `.gitignore` 忽略（`.env` 与 `server/data/`），**严禁提交或打进镜像/压缩包分发**。
- [ ] **`DRA_JWT_SECRET` 显式配置**：避免依赖自动生成的 `jwt.secret` 文件（日志会有警告）；更换该密钥会使所有已发 token 失效，可作为紧急登出手段。
- [ ] **helmet 已内置**：服务端挂载 helmet 安全响应头（HSTS、X-Frame-Options 等）；CSP 默认禁用——生产同源部署下面内联样式与画布 iframe 预览依赖宽松策略，同源下无跨站脚本注入面。若需收紧 CSP 请先完整回归画布预览功能。
- [ ] **内置限流已生效，注意反代下的计数语义**：`/api` 全局 300 次/分/IP，admin 路由独立 100 次/分，注册/登录有独立限流。**注意：当前版本未设置 `trust proxy`**，Nginx 反代后 Express 看到的客户端 IP 是回源地址（127.0.0.1），即全站用户共享 300 次/分额度；用户量增长后需在代码中启用 `app.set('trust proxy', 1)`（信任 Nginx 透传的 `X-Forwarded-For`）恢复按真实 IP 限流，或经评估上调全局限流额度。
- [ ] **JSON body 上限 32mb**：服务端已限制；Nginx 侧 `client_max_body_size 32m` 对齐（第 7 章），防止超大 payload 攻击绕过。
- [ ] **定期查看审计日志**：管理员动作与内容治理事件统一落 `audit_logs` 表，管理后台提供分页查询（`GET /api/admin/audit-logs?page=&action=`），建议纳入例行巡检。
- [ ] **封禁处置流程**：发现违规账号 → 管理后台用户管理中封禁（可附 `ban_reason` 与 `banned_until`）→ 封禁即时生效（token 校验会检查用户状态）；同步在审计日志留痕。违规内容经举报入口（`POST /api/reports`）进入治理队列。
- [ ] **密钥管理**：各 LLM 平台密钥优先在管理后台配置（AES-256-GCM 加密落库），避免写入 `.env` 明文扩散；`DRA_MASTER_KEY` 一旦泄露，需轮换并重新配置全部平台密钥。

## 13. 故障排查

| 现象 | 原因与处置 |
|---|---|
| `curl 127.0.0.1:3001/api/health` 通，但外部访问 502 | Nginx 未启动/配置错误：`nginx -t` 看报错；确认 `proxy_pass` 端口与 `PORT` 一致 |
| 日志出现 `port 3001 in use, trying next…` | 端口被占，服务端自动改听 3002+，导致 Nginx 代理错位。排查占用：`sudo lsof -i:3001`；杀掉占用进程或改 `PORT`；生产务必固定 `PORT=3001` 并保证启动前端口空闲 |
| 启动即退出，日志 `数据库迁移失败，终止启动` | 看 stderr 具体报错：多为 `server/data` 目录无写权限（chown 运行用户）、磁盘满，或库文件损坏（从备份恢复，见第 10 章）。迁移版本表为 `_migrations`，切勿手工增删其中记录 |
| 浏览器控制台 CORS 报错 | 生产要求**同源部署**（页面与 API 同经 Nginx）。若前端单独域名调试，把该来源加入 `DRA_CORS_ORIGINS`（逗号分隔）后重启；同源/无 Origin 请求不受白名单限制 |
| 流式对话卡住、整段一次性输出、或 SSE 502/超时 | Nginx 缓冲未关：确认 `proxy_buffering off;` 与 `proxy_read_timeout 3600s;`（第 7 章）；502 多为 upstream 掉线，`pm2 logs` / `journalctl -u dra-agent` 查崩溃原因 |
| 上传大文件报 413 Request Entity Too Large | Nginx `client_max_body_size` 小于请求体：调整为 `32m` 与服务端对齐（第 7 章） |
| `SQLITE_BUSY` / database is locked | WAL 模式下单进程正常不会出现；多为手工执行 `migrate` / `import-legacy` 与长写事务并发，或另一个进程（如误启动第二个实例）占用写锁。确保 `instances: 1`（pm2），操作完毕后重试 |
| 打开首页 404 / 只有 API 正常 | `CLIENT_DIST_DIR` 未设置或指错：必须指向**已构建**的 `client/dist`（存在 `index.html`），设置后重启进程 |
| 密钥相关功能报解密失败 | `DRA_MASTER_KEY` 或 `master.key` 被更换/丢失，已加密数据无法解密：恢复原密钥文件；无法恢复则在管理后台重新配置全部平台密钥 |

---

*本文档基于代码库实际实现编写（端口、脚本名、环境变量名均与 `server/src` 一致）。桌面版构建（Windows NSIS / Portable）见 `electron-builder.yml` 与根 `package.json` 的 `electron:build` script。*
