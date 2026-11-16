# RNGdle AI

为 **Digit Composition、Time Collection、Target Chase、Digit Climb、Digit Poker、Digit Claim** 提供可跨 API Token 混搭的 AI 配置组、独立游戏权限、API 文档和 Element UI 在线体验。

## 功能与规则

- 复用项目内的 `calculator.js` 官方计分器、徽章定义和家族最高分规则；每个 API Token 的各游戏模式分别引用一个配置组，配置组可跨 Token 和模式复用。未知徽章不计入该游戏的评分。
- Digit Composition 遍历合法的 3 Key / 5 Open 组合，Key 仅放在第 2、5 位，每枚数字最多使用一次；六位数字串允许首位为 0，AI 响应同时提供保留前导零的 `digits` 字符串和数值型 `number`。
- Time Collection 仅返回 `take` 或 `skip`，不支持替换已收数字。可出现数字限定为官方全量计分百分位 ≥ 50%（Uncommon 或更高）；AI 的有限时域动态规划在同一候选数字集合上，按当前已知徽章配置计算精确分数分布与最优门槛。API 支持任意长度对局：`decide` 的 `remainingTurns` 接受 1–200、`slotsRemaining` 接受 0–10，`collection-thresholds` 可通过 `{"turns":12}` 获取平局加时赛（12 轮）或任意轮数的门槛表。
- Target Chase 仅枚举修改一个数字位的合法候选，按当前 API token 已知徽章计算候选分数，再比较用户传入的目标分数。
- Digit Climb 将起始整数左侧补零为六位数后执行带权最短路径搜索（例如 `60451` 解释为 `060451`），在 3、3.5、5、5.5、7 或 7.5 的预算内组合单步升降（1）、相邻位交换（1.5）和任意设置一位（3），按当前 Token 已知徽章分数返回最优五个可达数字；可同时校验玩家答案是否符合预算。
- Digit Poker 是 2–6 人好友娱乐模式（不计排位分/每日奖励）：每人 10,000 筹码，主持人选择 1–10 轮，每轮固定庄家轮转（N 人打 N 手），盲注恒为 50/100，无重买。每手用 3 张私有 + 5 张公共数字填 6 个槽位（第 2、5 位必须私有，每枚数字最多用一次），以最高徽章 EP 决胜负，平分则平分底池、不等额全下形成边池。首手发 2 条鱼、此后每手 +1，主池独赢者得鱼、平分则顺延；鱼费 2.5 BB，每轮末结算（有鱼者向每个零鱼者收 `鱼数 × floor((鱼数+1)/2) × 鱼费`）后清鱼，筹码 ≤0 离桌，其余人保留余额进入下一轮。API 的 `construct` 返回最高 EP 排列并支持按 `fixed` 补全最低 EP 合法完成，`bet` 返回 `fold/check/call/raise/allin` 与 EP 强度。所有游玩数据（玩家数、筹码、盲注、鱼费、轮数、位数、计时等）都可通过 `rules` 覆盖。
- Digit Claim 是排位 1v1 模式，拥有独立的 Elo 与排行榜。每场比赛开始时随机决定谁先领取（排位赛、友谊赛和练习一致），被抽中的一方记为 A，领取顺序仍为 `A B B A A B B A A B B A A B`，第一次领取之后双方各连续领取两次，最终每人 7 个数字。每人有六个固定格（从左到右组成六位数）和一个自由格：自由格可以先留住一个数字，之后可将其移入空的固定格；领取的数字可放入任意空格，自由格里的数字不参与最终数字。双方状态公开，EP 高者获胜。只要还有选择，玩家的最后一次领取由玩家自己完成：自由格有数字且还有空固定格时，可先把自由格数字移入固定格、再把最后一个数字放进自由格；只有最后一个数字只能放进自由格时才由系统代为完成。每位玩家的全部领取共有 60 秒，只在自己的回合计时；一方时间用完后只有这一方的剩余领取随机完成，另一方仍用自己的时间下到最后。若选择时时钟用完，已选数字与已安排的自由格移动保留，其余部分随机完成。AI 决策返回建议领取的数字、放置方案（是否先把自由格移入固定格、放入哪个固定格或自由格），以及按当前 Token 已知徽章计算的当前方最高 EP 与对手对照分。剩余领取次数可用 `claimsRemaining`/`opponentClaimsRemaining`，或用 `order` + `index` 推导。
- Time Collection 的 Uncommon 候选数字分布由官方全量计分百分位确定，再由 JavaScript 计分器按当前用户已知徽章配置计算该集合的分数；Target Chase 也用同一配置计算每个单数字变更候选的分数。服务不依赖 `ep-table.bin.gz` 或其他预生成 EP 表。
- 每种不同的 Time Collection 认知配置会计算并缓存 0–1,000,000 范围内、官方计分百分位 ≥ 50% 的个性化分数分布。符合条件的数字集合在服务进程中共享缓存；每组最优门槛 DP 会以版本化 JSON 文件持久化到数据目录的 `time-collection-dp/`，服务重启后可直接复用，避免重复扫描和计分。注册、读取用户配置和保存配置后会在后台预热对应分布；首次决策若预热尚未完成，会等待同一个计算任务。计算期间会定期让出事件循环。
- 配置页支持按中英文搜索官方计分规则，并在详情对话框中查看中文规则说明、英文原文、官方分值、出现概率和计分家族。
- API 只返回当前题目的建议；对局状态、计时、完整胜负与排名结算由调用方维护。
- 登录后的个人主页按游戏和总计显示成功游戏 API 调用、决策、API 游戏会话、Token 数和 UTC 小时/日/月/年调用数；更新功能前没有历史统计的账户默认为 0。在线体验提供玩家对 AI 的完整练习对局，可使用当前账户已选 Token 的配置或输入一个 API Token。
- 在线练习赛将六款游戏分别实现为独立 Vue 页面：Digit Composition 四道题共用 120 秒（可调整）；Time Collection 30 个数字、每步 5 秒、双方各 5 个槽位，并显示按当前剩余槽位动态更新的 30 位置最优 EP 门槛表；Target Chase 10 回合、每步 10 秒；Digit Climb 四个不同起点依次使用预算 3.5、5.5、5.5、7.5，共用 120 秒；Digit Poker 为 2–6 人好友牌桌，人类坐 0 号位、其余为 AI 机器人，逐手完成下注（15 秒/步）、最终构造（30 秒）与鱼费结算；Digit Claim 为 1v1 数字池领取，开始时随机决定人类为 A 还是 B，按 `A B B A A B B A A B B A A B` 顺序轮流领取，每人全部领取共 60 秒、只在自己回合计时，超时后仅超时一方的剩余领取随机完成，可用「采用 AI 建议」一键领取。超时判负；练习赛回合数和胜负方式不是原游戏排位规则。自定义 API Token 只在当前页面内存中使用，不保存到浏览器存储。
- 用户凭证、API Token 和 AI 会话按用户隔离；每个 Token 的各模式可分别选择账户下任意配置组，同一配置组可同时被多个 Token 或多个模式使用；游戏访问权限仍按 Token 隔离。创建 Token 时会为每个模式生成默认配置组，旧 Token 配置会在升级首次启动时迁移为各模式配置组。个人 `rng_...` API Token 可编辑用途、调整游戏权限、轮换或撤销；这些管理操作只能由网站登录会话执行。
- 无第三方 npm 运行依赖；用户数据以 JSON 文件持久化。API 文档整合在主应用中，可在登录前通过首页的「API 文档」入口查看；旧 `/docs.html` 地址会跳转至该页面。

## 快速部署

需要 Node.js 22.9 或更高版本（建议使用 Node.js 24 LTS）。官方计算器文件 `calculator.js` 必须与服务端文件一起部署。

```sh
npm start
```

默认监听 `0.0.0.0:3000`。访问 `http://localhost:3000`，先由管理员配置 OAuth 提供商，再通过 OAuth 注册账户；已有账户仍可使用用户名和密码登录。服务仅需持久化用户数据目录；游戏得分和收集分布由内置 JavaScript 计分器计算。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_FILE` | `./data/store.json` | 用户、密码哈希、token 哈希、token 配置和游戏会话文件；Time Collection DP 缓存保存在同目录的 `time-collection-dp/` |
| `ROOT_USERNAME` | `root` | 设置 `ROOT_PASSWORD` 时用作初始管理员用户名，需为 3–32 位字母、数字、下划线或连字符 |
| `ROOT_PASSWORD` | 无 | 首次启动时创建 root 管理员；必须为 10–200 个字符。请通过部署平台的密钥管理设置，不要写入仓库 |
| `OAUTH_ENCRYPTION_KEY` | 无 | 管理员保存 OAuth 配置前必需；请提供至少 32 个字符的随机密钥，并在重启、备份恢复和迁移时保持不变 |
| `PUBLIC_BASE_URL` | 开发环境由请求 Host 推断 | 部署在反向代理后时，配置浏览器可访问的站点 origin，例如 `https://rngdle.example.com`；生产环境必填且必须使用 HTTPS |

部署不需要下载或挂载 `ep-table.bin.gz`。历史遗留的 EP 表文件不会被服务读取。

### 后端模块

- `games/digit-composition.js`、`games/time-collection.js`、`games/target-chase.js`、`games/digit-climb.js`、`games/digit-poker.js`、`games/digit-claim.js`：六个游戏的决策逻辑；`games/common.js` 和 `games/index.js` 管理共享配置与调度。
- `users.js`：账户、密码、会话、API Token、OAuth 身份及加密提供商配置的持久化；root 管理员引导。
- `api.js`：认证、OAuth 授权码回调、用户绑定和管理面板 API 路由。
- `server.js`：HTTP 服务启动、静态文件和请求错误处理。

### OAuth 与管理员部署

1. 在部署平台设置 `ROOT_PASSWORD`（至少 10 个字符）和可选 `ROOT_USERNAME`，首次启动且数据中尚无 root 时创建 root 管理员。已有 root 后，启动过程不再读取或应用这两个引导值；root 密码只通过个人主页更改。若首次初始化时用户名已被普通账户占用，服务会拒绝启动而不是擅自提升该账户；此时请选择未占用的用户名。未配置 `ROOT_PASSWORD` 时不会自动创建默认管理员账户。
2. 设置固定的 `OAUTH_ENCRYPTION_KEY`（建议使用密码管理器生成的 32 字节以上随机值），以及生产站点的 `PUBLIC_BASE_URL`。更改或丢失加密密钥会导致已保存的 OAuth Client Secret 无法解密；请将密钥与数据备份分别安全保管。
3. 使用 root 登录后，在「管理面板 → OAuth 提供商」录入 OAuth 2.0 或 OpenID Connect 配置。每个提供商的回调 URI 固定为 `{PUBLIC_BASE_URL}/api/auth/oauth/{id}/callback`，需在 OAuth 服务商控制台逐字登记。生产端点必须使用 HTTPS；开发环境允许 HTTP 以便本地测试。
4. 用户可在登录页的「创建账户」模式通过 OAuth 注册，在「登录」模式通过 OAuth 登录；密码注册接口已关闭，已有密码账户的登录不受影响。OAuth 身份仅以提供商 ID + subject 识别；不会仅因邮箱相同自动关联密码账户。登录后也可在个人主页显式绑定。root 不可由管理面板停用、降权或删除；网站至少保留一名启用管理员。

#### Codeforces OIDC 配置

Codeforces 使用 OpenID Connect，不能按需要 UserInfo 端点的普通 OAuth 配置。管理面板中填写：

| 字段 | 值 |
|---|---|
| 提供商 ID | `codeforces` |
| 显示名称 | `Codeforces` |
| 授权地址 | `https://codeforces.com/oauth/authorize` |
| 令牌地址 | `https://codeforces.com/oauth/token` |
| Issuer | `https://codeforces.com` |
| 用户信息地址 | 留空 |
| Scopes | `openid` |
| 唯一身份字段 | `sub` |
| PKCE | 关闭 |

Client ID 和 Client Secret 使用 Codeforces OAuth App 提供的值。将本站回调 URI 登记到 OAuth App 的 Redirect URIs 中，必须与部署地址完全一致；固定格式为 `{PUBLIC_BASE_URL}/api/auth/oauth/codeforces/callback`，例如本地开发时为 `http://localhost:3000/api/auth/oauth/codeforces/callback`。Issuer 按 ID token 的 `iss` 原值比较，不要自行增删尾部斜杠。网站会验证 ID token 的 HS256 签名、Issuer、Audience、有效期和 nonce。

如果 401 出现在跳转到 Codeforces 后、本站回调之前，优先确认 Codeforces App 的 Client ID 和已登记的 Redirect URI 与本站实际发出的值完全一致；若错误发生在本站回调之后，再检查 Client Secret 及以上 OIDC 配置。不要向他人发送 Client Secret、授权码、state 或 token。

OAuth 流程使用短时一次性 state；PKCE 可按提供商支持情况启用或关闭。网站端点应仅经 HTTPS 对外服务。`OAUTH_ENCRYPTION_KEY` 和 `ROOT_PASSWORD` 不会写入用户数据或 API 响应。普通 OAuth 提供商需支持授权码、令牌交换及返回唯一 subject 的 JSON 用户信息端点；OIDC 提供商需返回本站支持算法的 ID token。

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

本地开发环境变量保存在被 `.gitignore` 忽略的 `.env` 文件中，`npm run dev` 和 `npm start` 会自动加载。当前工作区已填好本地 root 账户：

- 用户名：`root_admin`
- 密码：`LocalRoot-Dev-2026-ChangeMe!`
- 本地地址：`http://localhost:3000`

此密码和 `.env` 中的加密密钥只供本机开发使用，不要用于生产部署。`npm test` 使用 [test/oauth-admin.test.js](./test/oauth-admin.test.js) fixture 中独立的临时目录和测试环境变量，不读取或依赖本机 `.env`。

```sh
npm run dev
npm test
```

## API

详见首页的「API 文档」入口（无需登录），或登录后的「API 文档」导航。基本流程：

1. 通过已配置的 OAuth 提供商创建账户（已有账户可用用户名密码登录），再创建个人 API Token 并选择该 token 允许访问的游戏。
2. 在控制台为目标 token 单独设置 AI 配置；`POST /api/games` 创建的会话绑定到当前 token。
3. 每次数字/题目产生后，调用 `POST /api/games/{game_id}/decide`，提交当前数字和所需局部信息。
4. 调用方使用返回建议更新自己的游戏；本服务不会保存/运行完整对局。

除注册、登录和公开状态外，请将个人 Token 通过标准 HTTP `Authorization` 认证头传入。配置修改、游戏权限和 Token 管理必须使用网站登录会话；API Token 只能访问其授权游戏，并使用自身 AI 配置进行决策。旧账户级配置在启动迁移时复制到已有 Token；没有 Token 的旧账户会在首次创建 Token 时迁移原配置。

`GET /api/me/stats` 仅接受网站登录会话。统计按账户持久化；游戏 API 调用包含成功创建 API 游戏会话、成功决策和成功计分的请求，失败请求不计入。对局页面的胜负比较方式是本站练习赛设定，不代表原游戏排位计分。

Token 管理支持通过 `PUT /api/auth/tokens/{token_id}` 更新用途和授权游戏，以及通过 `POST /api/auth/tokens/{token_id}/rotate` 轮换凭证。轮换会立即使旧 Token 失效，保留其 AI 配置、用途、权限和已有游戏会话绑定；新 Token 明文只在创建或轮换响应中返回。

## 数据与安全说明

- 密码以带随机盐的 scrypt 哈希存储；网站 session/API Token 仅以 SHA-256 哈希落盘，Token 明文只在创建或轮换时返回。
- 使用 HTTPS 反向代理保护凭证传输；不要公开暴露未启用 TLS 的服务端口。
- 单实例部署使用原子替换的 JSON 文件持久化，OAuth state 暂存于进程内存。多实例/高并发部署应迁移到支持事务的共享数据库和共享的一次性 state 存储。
