"use strict";

const crypto = require("node:crypto");
const {
  DecisionInputError,
  FEATURES,
  GAME_IDS,
  defaultConfig,
  decide,
  prewarmCollection,
} = require("./games");
const { UserError } = require("./users");

const MAX_BODY_BYTES = 64 * 1024;

function scheduleCollectionWarmup(config, reason) {
  setImmediate(() => {
    prewarmCollection(config).catch((error) => {
      console.error(`Failed to prewarm Time Collection thresholds after ${reason}:`, error);
    });
  });
}

function jsonResponse(res, status, body) {
  const output = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": output.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(output);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UserError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return reject(new UserError(400, "JSON body must be an object"));
        }
        resolve(body);
      } catch {
        reject(new UserError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function createApiHandler(userService) {
  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method === "GET" && pathname === "/api/status") {
      jsonResponse(res, 200, {
        games: GAME_IDS,
        features: FEATURES,
        defaultConfig: defaultConfig(),
        scoringEngine: "calculator.js",
      });
      return;
    }

    if (method === "POST" && pathname === "/api/auth/register") {
      const body = await parseBody(req);
      const result = await userService.register(body);
      jsonResponse(res, 201, result);
      return;
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const result = await userService.login(body);
      const firstToken = Object.values(result.user?.apiTokens || {})[0];
      if (firstToken?.config && firstToken.allowedGames.includes("collection")) {
        scheduleCollectionWarmup(firstToken.config, "login");
      }
      jsonResponse(res, 200, result);
      return;
    }

    const auth = userService.authenticate(req);
    if (!auth) throw new UserError(401, "需要有效的 Bearer token");
    const { user, username } = auth;

    if (method === "POST" && pathname === "/api/auth/logout") {
      await userService.logout(auth);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/me") {
      jsonResponse(res, 200, userService.safeSummary(username, user, auth));
      return;
    }

    if (method === "GET" && pathname === "/api/me/stats") {
      if (auth.kind !== "session") {
        throw new UserError(403, "个人统计仅可通过网站登录会话查看");
      }
      jsonResponse(res, 200, userService.getUsageStats(user));
      return;
    }

    if (method === "POST" && pathname === "/api/auth/tokens") {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话管理 API token");
      }
      const body = await parseBody(req);
      const label = typeof body.label === "string" ? body.label.trim().slice(0, 40) : "API token";
      const result = await userService.createApiToken(
        user,
        label || "API token",
        body.allowedGames === undefined ? GAME_IDS : body.allowedGames,
      );
      const tokenRecord = userService.findApiToken(user, result.id).token;
      if (tokenRecord.allowedGames.includes("collection")) {
        scheduleCollectionWarmup(tokenRecord.config, "token creation");
      }
      jsonResponse(res, 201, result);
      return;
    }

    const tokenConfigMatch = /^\/api\/auth\/tokens\/([^/]+)\/config$/.exec(pathname);
    if (method === "PUT" && tokenConfigMatch) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话修改 token 配置");
      }
      const tokenId = decodeURIComponent(tokenConfigMatch[1]);
      const body = await parseBody(req);
      const config = await userService.updateApiTokenConfig(user, tokenId, body.config ?? body);
      const { token } = userService.findApiToken(user, tokenId);
      if (token.allowedGames.includes("collection")) {
        scheduleCollectionWarmup(config, "token configuration save");
      }
      jsonResponse(res, 200, { config });
      return;
    }

    const tokenGamesMatch = /^\/api\/auth\/tokens\/([^/]+)\/games$/.exec(pathname);
    if (method === "PUT" && tokenGamesMatch) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话修改 token 游戏权限");
      }
      const tokenId = decodeURIComponent(tokenGamesMatch[1]);
      const body = await parseBody(req);
      const allowedGames = await userService.updateApiTokenGames(user, tokenId, body.allowedGames);
      jsonResponse(res, 200, { allowedGames });
      return;
    }

    const tokenDetailsMatch = /^\/api\/auth\/tokens\/([^/]+)$/.exec(pathname);
    if (method === "PUT" && tokenDetailsMatch) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话管理 API token");
      }
      const tokenId = decodeURIComponent(tokenDetailsMatch[1]);
      const body = await parseBody(req);
      const token = await userService.updateApiTokenDetails(
        user,
        tokenId,
        body.label,
        body.allowedGames,
      );
      jsonResponse(res, 200, token);
      return;
    }

    const tokenRotateMatch = /^\/api\/auth\/tokens\/([^/]+)\/rotate$/.exec(pathname);
    if (method === "POST" && tokenRotateMatch) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话轮换 API token");
      }
      const tokenId = decodeURIComponent(tokenRotateMatch[1]);
      const result = await userService.rotateApiToken(user, tokenId);
      jsonResponse(res, 200, result);
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/auth/tokens/")) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话管理 API token");
      }
      const tokenId = decodeURIComponent(pathname.slice("/api/auth/tokens/".length));
      await userService.revokeApiToken(user, tokenId);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/games") {
      const body = await parseBody(req);
      if (!GAME_IDS.includes(body.game)) {
        throw new UserError(400, `game 必须是 ${GAME_IDS.join(", ")}`);
      }
      const tokenEntry = auth.kind === "api"
        ? { tokenHash: auth.tokenHash, token: user.apiTokens[auth.tokenHash] }
        : body.tokenId
          ? userService.findApiToken(user, body.tokenId)
          : null;
      if (!tokenEntry) throw new UserError(400, "网站会话创建游戏时必须提供 tokenId");
      if (!tokenEntry.token) throw new UserError(401, "API token 无效或已撤销");
      if (!tokenEntry.token.allowedGames.includes(body.game)) {
        throw new UserError(403, `此 API token 不允许访问 ${body.game}`);
      }
      const gameId = crypto.randomUUID();
      user.games[gameId] = {
        game: body.game,
        tokenHash: tokenEntry.tokenHash,
        createdAt: new Date().toISOString(),
      };
      userService.recordApiUsage(user, body.game, "game");
      const gameEntries = Object.entries(user.games)
        .sort((a, b) => b[1].createdAt.localeCompare(a[1].createdAt));
      user.games = Object.fromEntries(gameEntries.slice(0, 100));
      await userService.persist();
      jsonResponse(res, 201, {
        game_id: gameId,
        game: body.game,
        message: "仅创建 AI 会话标识；对局状态由调用方维护。",
      });
      return;
    }

    const decisionMatch = /^\/api\/games\/([0-9a-f-]+)\/decide$/.exec(pathname);
    if (method === "POST" && decisionMatch) {
      const game = user.games[decisionMatch[1]];
      if (!game) throw new UserError(404, "游戏不存在或不属于当前用户");
      if (auth.kind === "api" && game.tokenHash !== auth.tokenHash) {
        throw new UserError(403, "此游戏会话不属于当前 API token");
      }
      const token = user.apiTokens[game.tokenHash];
      if (!token) throw new UserError(404, "此游戏会话绑定的 API token 已撤销");
      if (!token.allowedGames.includes(game.game)) {
        throw new UserError(403, `此 API token 不允许访问 ${game.game}`);
      }
      const body = await parseBody(req);
      try {
        const decision = await decide(game.game, body, token.config);
        userService.recordApiUsage(user, game.game, "decision");
        await userService.persist();
        jsonResponse(res, 200, { game_id: decisionMatch[1], decision });
      } catch (error) {
        if (!(error instanceof DecisionInputError)) throw error;
        throw new UserError(400, error.message);
      }
      return;
    }

    throw new UserError(404, "API endpoint not found");
  }

  return { handle };
}

module.exports = { createApiHandler, jsonResponse };
