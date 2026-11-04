"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { defaultConfig, GAME_IDS, normalizeConfig } = require("./games");

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  const actual = crypto.scryptSync(password, user.password.salt, 64);
  const expected = Buffer.from(user.password.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createUserService(dataFile) {
  let store = { version: 1, users: Object.create(null) };
  let writeQueue = Promise.resolve();

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
      await persist();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await persist();
    }
  }

  function safeSummary(username, user, auth = null) {
    const tokenEntries = auth?.kind === "api"
      ? [[auth.tokenHash, user.apiTokens[auth.tokenHash]]]
      : Object.entries(user.apiTokens || {});
    return {
      username,
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
    if (!GAME_IDS.includes(gameId) || !["game", "decision"].includes(action)) {
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
    if (!user || typeof body.password !== "string" || !verifyPassword(body.password, user)) {
      throw new UserError(401, "用户名或密码错误");
    }
    const token = makeToken("session_");
    user.sessions[hashToken(token)] = { expiresAt: Date.now() + SESSION_TTL_MS };
    await persist();
    return { token, user: safeSummary(username, user) };
  }

  function authenticate(req) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!match) return null;
    const tokenHash = hashToken(match[1]);
    const now = Date.now();
    for (const [username, user] of Object.entries(store.users)) {
      const session = user.sessions[tokenHash];
      if (session) {
        if (session.expiresAt > now) return { username, user, tokenHash, kind: "session" };
        delete user.sessions[tokenHash];
      }
      if (user.apiTokens[tokenHash]) return { username, user, tokenHash, kind: "api" };
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

  return {
    authenticate,
    createApiToken,
    findApiToken,
    getUsageStats,
    load,
    login,
    logout,
    persist,
    register,
    recordApiUsage,
    revokeApiToken,
    rotateApiToken,
    safeSummary,
    updateApiTokenConfig,
    updateApiTokenDetails,
    updateApiTokenGames,
  };
}

module.exports = { createUserService, UserError };
