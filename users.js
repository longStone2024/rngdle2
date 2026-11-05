"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { defaultConfig, GAME_IDS, normalizeConfig } = require("./games");

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SITE_INFO_DEFAULTS = {
  title: "RNGdle AI",
  description: "为三个 RNGdle 游戏配置和体验 AI。",
  announcement: "",
  supportUrl: "",
};

class UserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateAllowedGames(games) {
  if (!Array.isArray(games) || games.length === 0
      || games.some((game) => !GAME_IDS.includes(game))
      || new Set(games).size !== games.length) {
    throw new UserError(400, `allowedGames 必须是 ${GAME_IDS.join(", ")} 中至少一款不重复的游戏`);
  }
  return [...games];
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function makeToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

function emptyGameUsage() {
  return {
    apiCalls: 0,
    decisions: 0,
    games: 0,
    frequency: {
      hour: { period: "", count: 0 },
      day: { period: "", count: 0 },
      month: { period: "", count: 0 },
      year: { period: "", count: 0 },
    },
  };
}

function currentPeriod(date, period) {
  const iso = date.toISOString();
  if (period === "hour") return iso.slice(0, 13);
  if (period === "day") return iso.slice(0, 10);
  if (period === "month") return iso.slice(0, 7);
  return iso.slice(0, 4);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user.password?.salt || !user.password?.hash) return false;
  const actual = crypto.scryptSync(password, user.password.salt, 64);
  const expected = Buffer.from(user.password.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createUserService(dataFile) {
  let store = {
    version: 1,
    users: Object.create(null),
    oauthProviders: Object.create(null),
    oauthIdentities: Object.create(null),
    siteInfo: { ...SITE_INFO_DEFAULTS },
  };
  let writeQueue = Promise.resolve();
  const oauthStates = new Map();

  function encryptionKey() {
    const secret = process.env.OAUTH_ENCRYPTION_KEY;
    if (typeof secret !== "string" || secret.length < 32) {
      throw new UserError(503, "管理员需先配置至少 32 个字符的 OAUTH_ENCRYPTION_KEY 才能保存 OAuth client secret");
    }
    return crypto.createHash("sha256").update(secret).digest();
  }

  function encryptSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  }

  function decryptSecret(encrypted) {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(encrypted.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  function publicProvider(provider) {
    return {
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      clientId: provider.clientId,
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      userInfoUrl: provider.userInfoUrl,
      issuer: provider.issuer || "",
      pkceEnabled: provider.pkceEnabled !== false,
      scopes: provider.scopes,
      subjectField: provider.subjectField,
      hasClientSecret: Boolean(provider.clientSecret),
    };
  }

  function initializeRoot() {
    if (Object.values(store.users).some((user) => user.isRoot === true)) return;
    if (!process.env.ROOT_PASSWORD) return;
    const rootUsername = typeof process.env.ROOT_USERNAME === "string"
      ? process.env.ROOT_USERNAME.trim().toLowerCase()
      : "root";
    if (!/^[a-z0-9_-]{3,32}$/.test(rootUsername)
        || process.env.ROOT_PASSWORD.length < 10
        || process.env.ROOT_PASSWORD.length > 200) {
      throw new Error("ROOT_USERNAME must be a valid username and ROOT_PASSWORD must be 10–200 characters");
    }
    let root = store.users[rootUsername];
    if (root && root.isRoot !== true) {
      throw new Error("ROOT_USERNAME is already used by a non-root account; choose an unused username");
    }
    if (!root) {
      root = {
        password: makePassword(process.env.ROOT_PASSWORD),
        sessions: {},
        apiTokens: {},
        games: {},
        createdAt: new Date().toISOString(),
      };
      store.users[rootUsername] = root;
    }
    root.role = "admin";
    root.isRoot = true;
    root.disabled = false;
  }

  function validateEndpointUrl(value, label) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new UserError(400, `${label}必须是有效的 HTTP(S) URL`);
    }
    if (!["https:", ...(process.env.NODE_ENV === "production" ? [] : ["http:"])].includes(parsed.protocol)
        || parsed.username
        || parsed.password
        || parsed.hash) {
      throw new UserError(400, `${label}必须是有效的 HTTP(S) 地址（生产环境须使用 HTTPS），且不能包含凭据或片段`);
    }
    return parsed.toString();
  }

  function validateOAuthProvider(input, existing = null) {
    const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : existing?.id || "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!/^[a-z0-9_-]{2,40}$/.test(id)) {
      throw new UserError(400, "OAuth 提供商 ID 需为 2–40 位小写字母、数字、下划线或连字符");
    }
    if (!name || name.length > 80) throw new UserError(400, "OAuth 显示名称需为 1–80 个字符");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new UserError(400, "enabled 必须是布尔值");
    }
    const urls = {};
    for (const [field, label] of [
      ["authorizationUrl", "授权地址"],
      ["tokenUrl", "令牌地址"],
    ]) {
      const value = typeof input[field] === "string" ? input[field].trim() : "";
      urls[field] = validateEndpointUrl(value, label);
    }
    const issuerValue = typeof input.issuer === "string" ? input.issuer.trim() : "";
    if (issuerValue) validateEndpointUrl(issuerValue, "Issuer");
    const issuer = issuerValue;
    const userInfoValue = typeof input.userInfoUrl === "string" ? input.userInfoUrl.trim() : "";
    const userInfoUrl = userInfoValue ? validateEndpointUrl(userInfoValue, "用户信息地址") : "";
    const scopes = typeof input.scopes === "string"
      ? input.scopes.trim().split(/\s+/).filter(Boolean).join(" ")
      : "";
    if (!issuer && !userInfoUrl) {
      throw new UserError(400, "必须填写用户信息地址，或配置 OpenID Connect Issuer");
    }
    if (issuer && !scopes.split(/\s+/).includes("openid")) {
      throw new UserError(400, "OpenID Connect scopes 必须包含 openid");
    }
    if (input.pkceEnabled !== undefined && typeof input.pkceEnabled !== "boolean") {
      throw new UserError(400, "pkceEnabled 必须是布尔值");
    }
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    const clientSecret = typeof input.clientSecret === "string" && input.clientSecret
      ? input.clientSecret
      : existing?.clientSecret ? decryptSecret(existing.clientSecret) : "";
    if (!clientId || clientId.length > 500) throw new UserError(400, "OAuth Client ID 不能为空且最多 500 个字符");
    if (!clientSecret || clientSecret.length > 4000) throw new UserError(400, "OAuth Client Secret 不能为空且最多 4000 个字符");
    if (!scopes || scopes.length > 500) throw new UserError(400, "OAuth scopes 不能为空且最多 500 个字符");
    const subjectField = typeof input.subjectField === "string" ? input.subjectField.trim() : "sub";
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(subjectField)) {
      throw new UserError(400, "subjectField 格式无效");
    }
    return {
      id,
      name,
      enabled: input.enabled !== false,
      clientId,
      clientSecret: encryptSecret(clientSecret),
      ...urls,
      userInfoUrl,
      issuer,
      pkceEnabled: input.pkceEnabled !== false,
      scopes,
      subjectField,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function persist() {
    const snapshot = JSON.stringify(store, null, 2);
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      const temporary = `${dataFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, dataFile);
    });
    return writeQueue;
  }

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(dataFile, "utf8"));
      if (!parsed || typeof parsed.users !== "object" || Array.isArray(parsed.users)) {
        throw new Error("User data file has an invalid structure");
      }
      store = { ...parsed, users: Object.assign(Object.create(null), parsed.users) };
      store.oauthProviders = Object.assign(Object.create(null), parsed.oauthProviders || {});
      store.oauthIdentities = Object.assign(Object.create(null), parsed.oauthIdentities || {});
      store.siteInfo = { ...SITE_INFO_DEFAULTS, ...(parsed.siteInfo || {}) };
      for (const user of Object.values(store.users)) {
        user.sessions ||= {};
        user.apiTokens ||= {};
        user.games ||= {};
        const legacyConfig = user.config;
        if (legacyConfig && Object.keys(user.apiTokens).length === 0) {
          user.pendingConfigMigration = normalizeConfig(legacyConfig);
        }
        for (const token of Object.values(user.apiTokens)) {
          token.allowedGames = Array.isArray(token.allowedGames)
            && token.allowedGames.length > 0
            && token.allowedGames.every((game) => GAME_IDS.includes(game))
            ? [...new Set(token.allowedGames)]
            : [...GAME_IDS];
          token.config = normalizeConfig(token.config || legacyConfig);
        }
        delete user.config;
      }
      initializeRoot();
      await persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      initializeRoot();
      await persist();
    }
  }

  function safeSummary(username, user, auth = null) {
    const tokenEntries = auth?.kind === "api"
      ? [[auth.tokenHash, user.apiTokens[auth.tokenHash]]]
      : Object.entries(user.apiTokens || {});
    return {
      username,
      role: user.role || "user",
      isRoot: user.isRoot === true,
      disabled: user.disabled === true,
      hasPassword: Boolean(user.password?.salt && user.password?.hash),
      oauthIdentities: Object.entries(user.oauthIdentities || {}).map(([providerId, identity]) => ({
        providerId,
        subject: identity.subject,
        linkedAt: identity.linkedAt,
      })),
      apiTokens: tokenEntries
        .filter(([, entry]) => entry && typeof entry === "object")
        .map(([, entry]) => ({
          id: entry.id,
          label: entry.label,
          createdAt: entry.createdAt,
          rotatedAt: entry.rotatedAt || null,
          allowedGames: [...entry.allowedGames],
          config: normalizeConfig(entry.config),
        })),
    };
  }

  function getUsageStats(user, now = new Date()) {
    const storedGames = user.usageStats?.games || {};
    const games = Object.fromEntries(GAME_IDS.map((gameId) => {
      const saved = storedGames[gameId] || emptyGameUsage();
      const frequency = Object.fromEntries(["hour", "day", "month", "year"].map((period) => {
        const bucket = saved.frequency?.[period];
        return [
          period,
          bucket?.period === currentPeriod(now, period) && validCount(bucket.count) === bucket.count
            ? bucket.count
            : 0,
        ];
      }));
      return [gameId, {
        apiCalls: validCount(saved.apiCalls),
        decisions: validCount(saved.decisions),
        games: validCount(saved.games),
        frequency,
      }];
    }));
    const total = {
      apiCalls: 0,
      decisions: 0,
      games: 0,
      frequency: { hour: 0, day: 0, month: 0, year: 0 },
    };
    for (const stats of Object.values(games)) {
      total.apiCalls += stats.apiCalls;
      total.decisions += stats.decisions;
      total.games += stats.games;
      for (const period of ["hour", "day", "month", "year"]) {
        total.frequency[period] += stats.frequency[period];
      }
    }
    return {
      tokenCount: Object.keys(user.apiTokens || {}).length,
      total,
      games,
    };
  }

  function recordApiUsage(user, gameId, action, now = new Date()) {
    if (!GAME_IDS.includes(gameId) || !["game", "decision", "score"].includes(action)) {
      throw new Error("Invalid API usage event");
    }
    user.usageStats ||= { games: {} };
    user.usageStats.games ||= {};
    const stats = user.usageStats.games[gameId] ||= emptyGameUsage();
    stats.apiCalls = validCount(stats.apiCalls) + 1;
    stats.decisions = validCount(stats.decisions);
    stats.games = validCount(stats.games);
    stats.frequency ||= {};
    if (action === "game") stats.games += 1;
    if (action === "decision") stats.decisions += 1;
    for (const period of ["hour", "day", "month", "year"]) {
      const bucket = stats.frequency[period] ||= { period: "", count: 0 };
      const key = currentPeriod(now, period);
      if (bucket.period !== key || !Number.isSafeInteger(bucket.count) || bucket.count < 0) {
        bucket.period = key;
        bucket.count = 0;
      }
      bucket.count += 1;
    }
  }

  async function register(body) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
      throw new UserError(400, "用户名需为 3–32 位字母、数字、下划线或连字符");
    }
    if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 200) {
      throw new UserError(400, "密码长度需为 10–200 个字符");
    }
    if (Object.hasOwn(store.users, username)) throw new UserError(409, "用户名已被使用");

    const token = makeToken("session_");
    const user = {
      password: makePassword(body.password),
      role: "user",
      oauthIdentities: {},
      sessions: { [hashToken(token)]: { expiresAt: Date.now() + SESSION_TTL_MS } },
      apiTokens: {},
      games: {},
      createdAt: new Date().toISOString(),
    };
    store.users[username] = user;
    await persist();
    return { token, user: safeSummary(username, user) };
  }

  async function login(body) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const user = store.users[username];
    if (!user || user.disabled || typeof body.password !== "string" || !verifyPassword(body.password, user)) {
      throw new UserError(401, "用户名或密码错误");
    }
    const token = makeToken("session_");
    user.sessions[hashToken(token)] = { expiresAt: Date.now() + SESSION_TTL_MS };
    await persist();
    return { token, user: safeSummary(username, user) };
  }

  async function changePassword(user, currentPassword, newPassword, currentTokenHash) {
    if (!user.password?.salt || !user.password?.hash) {
      throw new UserError(400, "此账户没有密码登录方式，不能更改密码");
    }
    if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, user)) {
      throw new UserError(401, "当前密码不正确");
    }
    if (typeof newPassword !== "string" || newPassword.length < 10 || newPassword.length > 200) {
      throw new UserError(400, "新密码长度需为 10–200 个字符");
    }
    if (newPassword === currentPassword) {
      throw new UserError(400, "新密码不能与当前密码相同");
    }
    user.password = makePassword(newPassword);
    const currentSession = user.sessions[currentTokenHash];
    user.sessions = currentSession ? { [currentTokenHash]: currentSession } : {};
    await persist();
  }

  function authenticate(req) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!match) return null;
    const tokenHash = hashToken(match[1]);
    const now = Date.now();
    for (const [username, user] of Object.entries(store.users)) {
      const session = user.sessions[tokenHash];
      if (session) {
        if (session.expiresAt > now && !user.disabled) return { username, user, tokenHash, kind: "session" };
        delete user.sessions[tokenHash];
      }
      if (user.apiTokens[tokenHash] && !user.disabled) return { username, user, tokenHash, kind: "api" };
    }
    return null;
  }

  async function createApiToken(user, label, allowedGames = GAME_IDS) {
    if (Object.keys(user.apiTokens).length >= 20) {
      throw new UserError(400, "每个账户最多创建 20 个 API token");
    }
    const games = validateAllowedGames(allowedGames);
    const token = makeToken("rng_");
    const normalizedLabel = label || "API token";
    const id = crypto.randomUUID();
    const tokenHash = hashToken(token);
    user.apiTokens[tokenHash] = {
      id,
      label: normalizedLabel,
      createdAt: new Date().toISOString(),
      allowedGames: games,
      config: normalizeConfig(user.pendingConfigMigration || defaultConfig()),
    };
    delete user.pendingConfigMigration;
    await persist();
    return { token, id, label: normalizedLabel, allowedGames: games };
  }

  function findApiToken(user, tokenId) {
    const entry = Object.entries(user.apiTokens)
      .find(([, metadata]) => metadata.id === tokenId);
    if (!entry) throw new UserError(404, "未找到该 API token");
    return { tokenHash: entry[0], token: entry[1] };
  }

  async function updateApiTokenConfig(user, tokenId, config) {
    const { token } = findApiToken(user, tokenId);
    token.config = normalizeConfig(config);
    await persist();
    return token.config;
  }

  async function updateApiTokenGames(user, tokenId, allowedGames) {
    const { token } = findApiToken(user, tokenId);
    token.allowedGames = validateAllowedGames(allowedGames);
    await persist();
    return [...token.allowedGames];
  }

  async function updateApiTokenDetails(user, tokenId, label, allowedGames) {
    const { token } = findApiToken(user, tokenId);
    if (typeof label !== "string" || !label.trim() || label.trim().length > 40) {
      throw new UserError(400, "Token 用途需为 1–40 个字符");
    }
    const normalizedLabel = label.trim();
    const games = validateAllowedGames(allowedGames);
    token.label = normalizedLabel;
    token.allowedGames = games;
    await persist();
    return {
      id: token.id,
      label: token.label,
      allowedGames: [...token.allowedGames],
    };
  }

  async function rotateApiToken(user, tokenId) {
    const { tokenHash, token } = findApiToken(user, tokenId);
    const replacement = makeToken("rng_");
    const replacementHash = hashToken(replacement);
    for (const game of Object.values(user.games)) {
      if (game.tokenHash === tokenHash) game.tokenHash = replacementHash;
    }
    delete user.apiTokens[tokenHash];
    token.rotatedAt = new Date().toISOString();
    user.apiTokens[replacementHash] = token;
    await persist();
    return {
      token: replacement,
      id: token.id,
      label: token.label,
      allowedGames: [...token.allowedGames],
    };
  }

  async function revokeApiToken(user, tokenId) {
    const { tokenHash } = findApiToken(user, tokenId);
    delete user.apiTokens[tokenHash];
    await persist();
  }

  async function logout(auth) {
    if (auth.kind === "session") delete auth.user.sessions[auth.tokenHash];
    await persist();
  }

  function createOAuthState(providerId, flow, username = null) {
    const now = Date.now();
    for (const [state, record] of oauthStates) {
      if (record.expiresAt <= now) oauthStates.delete(state);
    }
    if (oauthStates.size >= 5000) throw new UserError(503, "OAuth 登录请求过多，请稍后重试");
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    oauthStates.set(state, {
      providerId,
      flow,
      username,
      verifier,
      nonce: crypto.randomBytes(32).toString("base64url"),
      browserBinding: crypto.randomBytes(32).toString("base64url"),
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });
    return {
      state,
      verifier,
      nonce: oauthStates.get(state).nonce,
      browserBinding: oauthStates.get(state).browserBinding,
      challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    };
  }

  function consumeOAuthState(state, providerId, browserBinding) {
    const record = oauthStates.get(state);
    oauthStates.delete(state);
    const binding = typeof browserBinding === "string" ? Buffer.from(browserBinding) : Buffer.alloc(0);
    const expectedBinding = record ? Buffer.from(record.browserBinding) : Buffer.alloc(0);
    const bindingMatches = binding.length === expectedBinding.length
      && crypto.timingSafeEqual(binding, expectedBinding);
    if (!record || record.expiresAt <= Date.now() || record.providerId !== providerId || !bindingMatches) {
      throw new UserError(400, "OAuth state 无效或已过期");
    }
    return record;
  }

  function getOAuthProvider(providerId, enabledOnly = true) {
    const provider = store.oauthProviders[providerId];
    if (!provider || (enabledOnly && !provider.enabled)) throw new UserError(404, "OAuth 提供商不存在或未启用");
    return {
      ...publicProvider(provider),
      clientSecret: decryptSecret(provider.clientSecret),
    };
  }

  function listOAuthProviders() {
    return Object.values(store.oauthProviders).map(publicProvider);
  }

  async function saveOAuthProvider(input, providerId = null) {
    const id = providerId || input.id;
    const existing = id ? store.oauthProviders[id] : null;
    if (providerId && !existing) throw new UserError(404, "OAuth 提供商不存在");
    const provider = validateOAuthProvider({ ...input, id }, existing);
    const hasIdentities = Object.keys(store.oauthIdentities).some((key) => key.startsWith(`${id}:`));
    if (existing && hasIdentities && [
      "authorizationUrl",
      "tokenUrl",
      "userInfoUrl",
      "issuer",
      "subjectField",
    ].some((field) => provider[field] !== existing[field])) {
      throw new UserError(409, "此提供商已有账户绑定，不能更改其端点或唯一身份字段；请先迁移或解除绑定");
    }
    store.oauthProviders[id] = provider;
    await persist();
    return publicProvider(provider);
  }

  async function deleteOAuthProvider(providerId) {
    if (!store.oauthProviders[providerId]) throw new UserError(404, "OAuth 提供商不存在");
    const linkedUsers = Object.entries(store.users).filter(([, user]) => user.oauthIdentities?.[providerId]);
    if (linkedUsers.some(([, user]) => !user.password && Object.keys(user.oauthIdentities).length === 1)) {
      throw new UserError(409, "仍有只依赖此 OAuth 提供商登录的账户，请先为这些账户添加其他登录方式");
    }
    for (const [, user] of linkedUsers) {
      const identity = user.oauthIdentities[providerId];
      delete store.oauthIdentities[`${providerId}:${identity.subject}`];
      delete user.oauthIdentities[providerId];
    }
    delete store.oauthProviders[providerId];
    await persist();
  }

  async function loginWithOAuth(providerId, subject, profile = {}, flow = "login") {
    if (typeof subject !== "string" || !subject || subject.length > 500) {
      throw new UserError(400, "OAuth 用户信息缺少有效的唯一 subject");
    }
    if (!["login", "register"].includes(flow)) {
      throw new UserError(400, "OAuth flow 必须是 login 或 register");
    }
    const identityKey = `${providerId}:${subject}`;
    let username = store.oauthIdentities[identityKey];
    let user = username ? store.users[username] : null;
    if (user?.disabled) throw new UserError(403, "此账户已停用");
    if (!user && flow === "login") {
      throw new UserError(404, "此 OAuth 身份尚未注册，请切换到注册并使用 OAuth 创建账户");
    }
    if (user && flow === "register") {
      throw new UserError(409, "此 OAuth 身份已注册，请切换到登录");
    }
    if (!user) {
      const sourceName = typeof profile.username === "string" && profile.username
        ? profile.username
        : typeof profile.email === "string" && profile.email.includes("@")
          ? profile.email.split("@")[0]
          : "oauth_user";
      const base = sourceName.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 24) || "oauth_user";
      username = base;
      for (let suffix = 1; Object.hasOwn(store.users, username); suffix++) {
        const tail = `_${suffix}`;
        username = `${base.slice(0, 32 - tail.length)}${tail}`;
      }
      user = {
        password: null,
        role: "user",
        oauthIdentities: {},
        sessions: {},
        apiTokens: {},
        games: {},
        createdAt: new Date().toISOString(),
      };
      store.users[username] = user;
      user.oauthIdentities[providerId] = { subject, linkedAt: new Date().toISOString() };
      store.oauthIdentities[identityKey] = username;
    }
    const token = makeToken("session_");
    user.sessions[hashToken(token)] = { expiresAt: Date.now() + SESSION_TTL_MS };
    await persist();
    return { token, user: safeSummary(username, user) };
  }

  async function bindOAuthIdentity(username, providerId, subject) {
    if (typeof subject !== "string" || !subject || subject.length > 500) {
      throw new UserError(400, "OAuth 用户信息缺少有效的唯一 subject");
    }
    const user = store.users[username];
    if (!user) throw new UserError(404, "用户不存在");
    if (user.disabled) throw new UserError(403, "此账户已停用");
    const identityKey = `${providerId}:${subject}`;
    const linkedUsername = store.oauthIdentities[identityKey];
    if (linkedUsername && linkedUsername !== username) {
      throw new UserError(409, "此 OAuth 身份已绑定到其他账户");
    }
    const existing = user.oauthIdentities?.[providerId];
    if (existing && existing.subject !== subject) {
      throw new UserError(409, "该提供商已绑定其他身份，请先解除绑定");
    }
    user.oauthIdentities ||= {};
    user.oauthIdentities[providerId] = { subject, linkedAt: new Date().toISOString() };
    store.oauthIdentities[identityKey] = username;
    await persist();
  }

  async function unlinkOAuthIdentity(username, providerId) {
    const user = store.users[username];
    if (!user?.oauthIdentities?.[providerId]) throw new UserError(404, "未找到此 OAuth 绑定");
    if (!user.password && Object.keys(user.oauthIdentities).length <= 1) {
      throw new UserError(400, "此账户没有密码且只绑定了一个 OAuth 登录方式，不能解除最后一个登录方式");
    }
    const identity = user.oauthIdentities[providerId];
    delete store.oauthIdentities[`${providerId}:${identity.subject}`];
    delete user.oauthIdentities[providerId];
    await persist();
  }

  function requireAdmin(auth) {
    if (!auth || auth.kind !== "session" || auth.user.role !== "admin") {
      throw new UserError(403, "此操作仅限管理员");
    }
  }

  function adminOverview() {
    const users = Object.entries(store.users);
    return {
      userCount: users.length,
      activeUserCount: users.filter(([, user]) => !user.disabled).length,
      disabledUserCount: users.filter(([, user]) => user.disabled).length,
      apiTokenCount: users.reduce((total, [, user]) => total + Object.keys(user.apiTokens || {}).length, 0),
      oauthProviderCount: Object.values(store.oauthProviders).filter((provider) => provider.enabled).length,
      boundOAuthIdentityCount: Object.keys(store.oauthIdentities).length,
    };
  }

  function listUsers() {
    return Object.entries(store.users).map(([username, user]) => ({
      username,
      role: user.role || "user",
      isRoot: user.isRoot === true,
      disabled: user.disabled === true,
      createdAt: user.createdAt,
      tokenCount: Object.keys(user.apiTokens || {}).length,
      oauthIdentities: Object.keys(user.oauthIdentities || {}),
    })).sort((left, right) => left.username.localeCompare(right.username));
  }

  async function updateUserAdmin(username, updates, actorUsername) {
    const user = store.users[username];
    if (!user) throw new UserError(404, "用户不存在");
    if (user.isRoot && actorUsername !== username) {
      throw new UserError(403, "不能修改 root 管理账户");
    }
    if (user.isRoot && (updates.role === "user" || updates.disabled === true)) {
      throw new UserError(400, "不能停用或降级 root 管理账户");
    }
    const removingActiveAdmin = user.role === "admin" && !user.disabled
      && (updates.role === "user" || updates.disabled === true);
    if (removingActiveAdmin
        && Object.values(store.users).filter((item) => item.role === "admin" && !item.disabled).length <= 1) {
      throw new UserError(400, "至少需要保留一名启用状态的管理员");
    }
    if (updates.role !== undefined) {
      if (!["admin", "user"].includes(updates.role)) throw new UserError(400, "role 必须是 admin 或 user");
      user.role = updates.role;
    }
    if (updates.disabled !== undefined) {
      if (typeof updates.disabled !== "boolean") throw new UserError(400, "disabled 必须是布尔值");
      user.disabled = updates.disabled;
      if (user.disabled) user.sessions = {};
    }
    await persist();
    return listUsers().find((item) => item.username === username);
  }

  async function deleteUserAdmin(username) {
    const user = store.users[username];
    if (!user) throw new UserError(404, "用户不存在");
    if (user.isRoot) throw new UserError(400, "不能删除 root 管理账户");
    if (user.role === "admin" && !user.disabled
        && Object.values(store.users).filter((item) => item.role === "admin" && !item.disabled).length <= 1) {
      throw new UserError(400, "不能删除最后一名启用状态的管理员");
    }
    for (const [providerId, identity] of Object.entries(user.oauthIdentities || {})) {
      delete store.oauthIdentities[`${providerId}:${identity.subject}`];
    }
    delete store.users[username];
    await persist();
  }

  function getSiteInfo() {
    return { ...SITE_INFO_DEFAULTS, ...store.siteInfo };
  }

  async function updateSiteInfo(input) {
    const next = {};
    for (const [field, maxLength] of [["title", 100], ["description", 500], ["announcement", 1000]]) {
      const value = typeof input[field] === "string" ? input[field].trim() : "";
      if (value.length > maxLength || (field === "title" && !value)) {
        throw new UserError(400, `${field} 无效或超出 ${maxLength} 个字符`);
      }
      next[field] = value;
    }
    const supportUrl = typeof input.supportUrl === "string" ? input.supportUrl.trim() : "";
    if (supportUrl) {
      let parsed;
      try {
        parsed = new URL(supportUrl);
      } catch {
        throw new UserError(400, "supportUrl 必须是有效的 HTTPS URL");
      }
      if (parsed.protocol !== "https:") throw new UserError(400, "supportUrl 必须使用 HTTPS");
    }
    next.supportUrl = supportUrl;
    store.siteInfo = next;
    await persist();
    return getSiteInfo();
  }

  return {
    authenticate,
    adminOverview,
    bindOAuthIdentity,
    changePassword,
    consumeOAuthState,
    createOAuthState,
    createApiToken,
    deleteOAuthProvider,
    deleteUserAdmin,
    getOAuthProvider,
    getSiteInfo,
    findApiToken,
    getUsageStats,
    load,
    login,
    loginWithOAuth,
    listOAuthProviders,
    listUsers,
    logout,
    persist,
    register,
    recordApiUsage,
    revokeApiToken,
    rotateApiToken,
    requireAdmin,
    saveOAuthProvider,
    safeSummary,
    unlinkOAuthIdentity,
    updateSiteInfo,
    updateUserAdmin,
    updateApiTokenConfig,
    updateApiTokenDetails,
    updateApiTokenGames,
  };
}

module.exports = { createUserService, UserError };
