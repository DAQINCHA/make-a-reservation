# 镜间 · 光影之艺影棚管理系统（Node 版）

原生 Node + 原生 HTML/CSS/JavaScript。运行时只用 Node 内置模块（`node:http`、`node:sqlite`、`node:crypto`），
`package.json` 里没有任何依赖，也没有构建步骤和 CDN。

需要 **Node.js 22.13 或更高版本**（内置 `node:sqlite`）。

双击 **启动镜间.command**，浏览器自动打开 **http://127.0.0.1:3288**。关闭终端窗口或按 Ctrl+C 停止服务。

启动脚本会按顺序找一个**能用 `node:sqlite` 的** Node：PATH 里的 `node` → Homebrew / `/usr/local` → WorkBuddy 自带的
`~/.workbuddy/binaries/node/versions`（先读 `current` 文件里的版本号，再退回该目录下任意版本）。
所以没把 Node 装进系统、只用 WorkBuddy 环境时，双击也能直接启动。

也可在本目录执行：

```sh
npm start                                # 仅本机访问
node server.js --host 0.0.0.0 --open     # 局域网共享
node server.js --db /路径/studio.sqlite   # 指定数据库
```

双击 **启动镜间.command** 默认按局域网共享启动：终端会同时打印本机地址与局域网地址，同一 Wi-Fi 下的手机、平板或其他电脑直接打开局域网地址即可（首次可能需要在「系统设置 → 网络 → 防火墙」允许 Node 接受连接）。局域网内任何设备都能访问登录页，请先改掉管理员初始密码。
默认端口为 **3288**，需要改端口时加 `--port 其他端口`。

## 数据库

与 Python 版**同一个库文件**，Schema、表结构、密码哈希（PBKDF2-SHA256，十万次迭代）、会话令牌哈希完全一致，
可以直接把 Python 版的 `data/studio.sqlite` 放到本目录 `data/` 下继续使用，也可以把本目录的库带回 Python 版。

启动时 `storage.js` 会做一次幂等的兼容升级，和 Python 版行为相同：

- 建表（`IF NOT EXISTS`），不覆盖已有数据；
- 旧库缺 `must_change_password` 列时补一列，**不改动任何已有密码，也不给任何账号打标记**；
- 清理旧版本遗留的「已取消」预约记录（只跑一次，第一次清理会让 `revision` +1）。

默认数据库路径是 `data/studio.sqlite`，可用 `--db` 指向别处。本目录 `data/studio.sqlite` 是现有业务库的副本，
原 Python 目录里的库未被修改。

## 文件

```text
make-a-reservation/
├── 启动镜间.command          # macOS 双击启动
├── package.json             # 只有 scripts，无依赖
├── server.js                # HTTP、静态资源、会话与五组 API
├── storage.js               # SQLite、PBKDF2-SHA256、初始化与兼容升级
├── validation.js            # 服务端字段、权限、预约与图片头校验
├── static/                  # 前端，与 Python 版逐字节一致
│   ├── index.html
│   ├── app.js               # DOM、事件、表格/卡片与原生 dialog
│   ├── domain.js            # 北京时间、按天预约、排序与图片信息
│   ├── native.css / globals.css / skin.css
│   ├── manifest.webmanifest # PWA 清单
│   ├── icons/               # PWA 图标
│   ├── icons.js
│   └── favicon.svg
└── data/
    ├── studio.sqlite       # 运行数据库（.gitignore 已排除）
    └── studio.initial-password.txt  # 首次启动生成，改密成功后自动删除
```

`data/` 含账号哈希与业务资料，已在 `.gitignore` 中排除。HTTP 只提供 `static/` 的文件和指定 API；
不会公开数据库、源代码或库文件。

## 首次启动

数据库不存在时初始化空工作区和管理员 `admin`，随机初始密码保存在数据库同目录的
`studio.initial-password.txt`（权限 `0600`）；终端会打印该文件路径。首次登录后必须设置至少 8 个字符的
新密码才能进入工作区，成功后自动删除初始密码文件。请勿分享或提交此文件。

升级不会重置现有密码，也不会改动或标记任何已有账号。

## 与 Python 版的差异

只换了运行时，功能与外观不变：API 路径、请求/响应格式、状态码、错误文案、Cookie、静态资源
（含 CSP 头与三个遗留 CSS 空响应）、头像分片存储、ETag/304、版本冲突 409、权限校验、
预约冲突与屏蔽规则、初始密码流程都按原实现逐条对齐。

需要留意的两点实现差异（对外行为一致）：

- **并发模型**：Python 用多线程 + `BEGIN IMMEDIATE` 串行化写事务；Node 是单线程，读完整请求体后
  再同步完成「开事务 → 校验 → 提交 → 关库」，因此同一个数据库的写操作天然串行，不会出现半截事务。
- **访问日志**：Python 的 `http.server` 会在终端打印每条请求，这里不打印。

## 自测

```sh
npm run check    # 三个文件的语法检查
```

前端逻辑回归测试仍在 Python 目录的 `tests/` 下（`test_domain.mjs`、`test_frontend.mjs`），
它们导入的是同一份 `static/` 代码，两边逐字节一致，改动前端后在那里跑一次即可。
