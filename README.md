# RNGdle AI

为 **Digit Composition、Time Collection、Target Chase** 提供按 API Token 隔离的 AI 配置、游戏权限、API 文档和 Element UI 在线体验。Poker 不在项目范围内。

## 功能与规则

- 复用项目内的 `calculator.js` 官方计分器、徽章定义和家族最高分规则；每款游戏分别保存 AI 已知的徽章。未知徽章不计入该游戏的评分。
- Digit Composition 遍历合法的 3 Key / 5 Open 组合，Key 仅放在第 2、5 位，每枚数字最多使用一次。
- Time Collection 仅返回 `take` 或 `skip`，不支持替换已收数字。基于当前已知徽章的分数分布及剩余回合、槽位，使用有限时域动态规划计算最优门槛。
- Target Chase 仅枚举修改一个数字位的合法候选，按当前 API token 已知徽章计算候选分数，再比较用户传入的目标分数。
- Time Collection 的全量候选分布由 JavaScript 计分器按当前用户已知徽章配置计算；Target Chase 也用同一配置计算每个单数字变更候选的分数。服务不依赖 `ep-table.bin.gz` 或其他预生成 EP 表。
- 每种不同的 Time Collection 认知配置会计算并缓存 0–1,000,000 的个性化分数分布。注册、读取用户配置和保存配置后会在后台预热对应分布；首次决策若预热尚未完成，会等待同一个计算任务，完成后后续请求复用内存缓存。计算期间会定期让出事件循环。
- 配置页支持按中英文搜索官方计分规则，并在详情对话框中查看中文规则说明、英文原文、官方分值、出现概率和计分家族。
- API 只返回当前题目的建议；对局状态、计时、完整胜负与排名结算由调用方维护。
- 登录后的个人主页按游戏和总计显示成功游戏 API 调用、决策、API 游戏会话、Token 数和 UTC 小时/日/月/年调用数；更新功能前没有历史统计的账户默认为 0。
- 用户凭证、API Token 和 AI 会话按用户隔离；AI 配置和可访问游戏按 token 隔离。个人 `rng_...` API Token 可编辑用途、调整游戏权限、轮换或撤销；这些管理操作只能由网站登录会话执行。
- 无第三方 npm 运行依赖；用户数据以 JSON 文件持久化。API 文档整合在主应用中，可在登录前通过首页的「API 文档」入口查看；旧 `/docs.html` 地址会跳转至该页面。

## 快速部署

需要 Node.js 22 或更高版本（建议使用 Node.js 24 LTS）。官方计算器文件 `calculator.js` 必须与服务端文件一起部署。

```sh
npm start
```

默认监听 `0.0.0.0:3000`。访问 `http://localhost:3000` 注册账户。服务仅需持久化用户数据目录；游戏得分和收集分布由内置 JavaScript 计分器计算。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_FILE` | `./data/store.json` | 用户、密码哈希、token 哈希、token 配置和游戏会话文件 |

部署不需要下载或挂载 `ep-table.bin.gz`。历史遗留的 EP 表文件不会被服务读取。

### 后端模块

- `games/digit-composition.js`、`games/time-collection.js`、`games/target-chase.js`：三个游戏的决策逻辑；`games/common.js` 和 `games/index.js` 管理共享配置与调度。
- `users.js`：账户、密码、会话和 API Token 持久化。
- `api.js`：认证后的 HTTP API 路由。
- `server.js`：HTTP 服务启动、静态文件和请求错误处理。

### Docker

```sh
docker build -t rngdle-ai .
docker run -d --name rngdle-ai \
  -p 3000:3000 \
  -v rngdle-ai-data:/app/data \
  --restart unless-stopped \
  rngdle-ai
```

Docker 镜像包含 `calculator.js` 和拆分后的游戏、用户及 API 模块。将 `/app/data` 挂载到持久化卷保存账户数据。生产环境应由 Caddy、Nginx 或平台入口提供 HTTPS。页面使用 CDN 加载 Vue 2 和 Element UI，因此浏览器需能访问 `unpkg.com`。

## 本地开发和测试

```sh
npm run dev
npm test
```

## API

详见首页的「API 文档」入口（无需登录），或登录后的「API 文档」导航。基本流程：

1. 注册账户并创建个人 API Token，同时选择该 token 允许访问的游戏。
2. 在控制台为目标 token 单独设置 AI 配置；`POST /api/games` 创建的会话绑定到当前 token。
3. 每次数字/题目产生后，调用 `POST /api/games/{game_id}/decide`，提交当前数字和所需局部信息。
4. 调用方使用返回建议更新自己的游戏；本服务不会保存/运行完整对局。

除注册、登录和公开状态外，请将个人 Token 通过标准 HTTP `Authorization` 认证头传入。配置修改、游戏权限和 Token 管理必须使用网站登录会话；API Token 只能访问其授权游戏，并使用自身 AI 配置进行决策。旧账户级配置在启动迁移时复制到已有 Token；没有 Token 的旧账户会在首次创建 Token 时迁移原配置。

`GET /api/me/stats` 仅接受网站登录会话。统计按账户持久化；游戏 API 调用包含成功创建 API 游戏会话和成功决策的请求，失败请求不计入。

Token 管理支持通过 `PUT /api/auth/tokens/{token_id}` 更新用途和授权游戏，以及通过 `POST /api/auth/tokens/{token_id}/rotate` 轮换凭证。轮换会立即使旧 Token 失效，保留其 AI 配置、用途、权限和已有游戏会话绑定；新 Token 明文只在创建或轮换响应中返回。

## 数据与安全说明

- 密码以带随机盐的 scrypt 哈希存储；网站 session/API Token 仅以 SHA-256 哈希落盘，Token 明文只在创建或轮换时返回。
- 使用 HTTPS 反向代理保护凭证传输；不要公开暴露未启用 TLS 的服务端口。
- 单实例部署使用原子替换的 JSON 文件持久化。多实例/高并发部署应迁移到支持事务的共享数据库和会话存储。
