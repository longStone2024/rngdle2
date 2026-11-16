"use strict";

const crypto = require("node:crypto");
const {
  DecisionInputError,
  FEATURES,
  GAME_IDS,
  defaultConfig,
  decide,
  getCollectionThresholdTable,
  isUncommonNumber,
  percentileForNumber,
  prewarmCollection,
  scoreNumber,
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

function jsonResponse(res, status, body, additionalHeaders = {}) {
  const output = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": output.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
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

function redirectOAuthResult(res, result, additionalHeaders = {}) {
  const headers = {
    Location: result,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...additionalHeaders,
  };
  res.writeHead(302, headers);
  res.end();
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return "";
}

function oauthCallbackUrl(req, providerId) {
  let base;
  if (process.env.PUBLIC_BASE_URL) {
    try {
      base = new URL(process.env.PUBLIC_BASE_URL);
    } catch {
      throw new UserError(503, "PUBLIC_BASE_URL 配置无效");
    }
    if (process.env.NODE_ENV === "production" && base.protocol !== "https:") {
      throw new UserError(503, "生产环境 PUBLIC_BASE_URL 必须使用 HTTPS");
    }
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new UserError(503, "生产环境需配置 PUBLIC_BASE_URL");
    }
    base = new URL(`http://${req.headers.host || "localhost"}`);
  }
  return new URL(`/api/auth/oauth/${encodeURIComponent(providerId)}/callback`, base).toString();
}

function getProfileValue(profile, path) {
  return path.split(".").reduce((value, part) => value && value[part], profile);
}

function verifyOpenIdToken(idToken, provider, expectedNonce) {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) throw new UserError(502, "OAuth token response contained an invalid ID token");

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new UserError(502, "OAuth ID token could not be decoded");
  }
  if (header.alg !== "HS256") throw new UserError(502, "OAuth ID token uses an unsupported signing algorithm");

  const expectedSignature = crypto
    .createHmac("sha256", provider.clientSecret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const actualSignature = Buffer.from(parts[2], "base64url");
  if (actualSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    throw new UserError(502, "OAuth ID token signature is invalid");
  }

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== provider.issuer
      || !audiences.includes(provider.clientId)
      || (audiences.length > 1 && claims.azp !== provider.clientId)
      || !Number.isFinite(claims.exp)
      || claims.exp <= now
      || claims.nonce !== expectedNonce
      || typeof claims.sub !== "string"
      || !claims.sub
      || claims.sub.length > 500) {
    throw new UserError(502, "OAuth ID token issuer, audience, expiry, nonce, or subject is invalid");
  }
  return claims;
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

    if (method === "GET" && pathname === "/api/site-info") {
      jsonResponse(res, 200, userService.getSiteInfo());
      return;
    }

    if (method === "GET" && pathname === "/api/auth/oauth/providers") {
      jsonResponse(res, 200, { providers: userService.listOAuthProviders().filter((provider) => provider.enabled) });
      return;
    }

    const oauthStartMatch = /^\/api\/auth\/oauth\/([a-z0-9_-]+)\/start$/.exec(pathname);
    if (method === "GET" && oauthStartMatch) {
      const providerId = decodeURIComponent(oauthStartMatch[1]);
      const flow = url.searchParams.get("flow") || "login";
      if (!["login", "register", "bind"].includes(flow)) {
        throw new UserError(400, "OAuth flow 必须是 login、register 或 bind");
      }
      const auth = userService.authenticate(req);
      if (flow === "bind" && (!auth || auth.kind !== "session")) {
        throw new UserError(401, "绑定 OAuth 需要先登录网站账户");
      }
      const provider = userService.getOAuthProvider(providerId);
      const callbackUrl = oauthCallbackUrl(req, providerId);
      const oauthState = userService.createOAuthState(
        providerId,
        flow,
        flow === "bind" ? auth.username : null,
      );
      const authorizationUrl = new URL(provider.authorizationUrl);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", provider.clientId);
      authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizationUrl.searchParams.set("scope", provider.scopes);
      authorizationUrl.searchParams.set("state", oauthState.state);
      if (provider.pkceEnabled) {
        authorizationUrl.searchParams.set("code_challenge", oauthState.challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
      }
      if (provider.issuer) authorizationUrl.searchParams.set("nonce", oauthState.nonce);
      const secureCookie = new URL(callbackUrl).protocol === "https:" ? "; Secure" : "";
      const cookiePath = `/api/auth/oauth/${providerId}/callback`;
      jsonResponse(res, 200, { authorizationUrl: authorizationUrl.toString() }, {
        "Set-Cookie": `rngdle_oauth_flow=${encodeURIComponent(oauthState.browserBinding)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie}`,
      });
      return;
    }

    const oauthCallbackMatch = /^\/api\/auth\/oauth\/([a-z0-9_-]+)\/callback$/.exec(pathname);
    if (method === "GET" && oauthCallbackMatch) {
      const providerId = decodeURIComponent(oauthCallbackMatch[1]);
      const oauthCookiePath = `/api/auth/oauth/${providerId}/callback`;
      try {
        const oauthState = userService.consumeOAuthState(
          url.searchParams.get("state"),
          providerId,
          getCookie(req, "rngdle_oauth_flow"),
        );
        if (url.searchParams.has("error")) throw new UserError(400, "OAuth 登录已取消或被拒绝");
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) throw new UserError(400, "OAuth authorization code 无效");
        const provider = userService.getOAuthProvider(providerId);
        const callbackUrl = oauthCallbackUrl(req, providerId);
        const tokenRequestBody = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
        });
        if (provider.pkceEnabled) tokenRequestBody.set("code_verifier", oauthState.verifier);
        const tokenResponse = await fetch(provider.tokenUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: tokenRequestBody,
        });
        if (!tokenResponse.ok) throw new UserError(502, `OAuth token endpoint returned HTTP ${tokenResponse.status}`);
        const tokenPayload = await tokenResponse.json();
        if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
          throw new UserError(502, "OAuth token response did not contain an access token");
        }
        let profile;
        if (provider.issuer) {
          profile = verifyOpenIdToken(tokenPayload.id_token, provider, oauthState.nonce);
        } else {
          const profileResponse = await fetch(provider.userInfoUrl, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/json" },
          });
          if (!profileResponse.ok) throw new UserError(502, `OAuth user-info endpoint returned HTTP ${profileResponse.status}`);
          profile = await profileResponse.json();
          if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
            throw new UserError(502, "OAuth user-info response must be a JSON object");
          }
        }
        const subject = getProfileValue(profile, provider.subjectField);
        const identitySubject = typeof subject === "string" || typeof subject === "number"
          ? String(subject)
          : "";
        let destination;
        if (oauthState.flow === "bind") {
          await userService.bindOAuthIdentity(oauthState.username, providerId, identitySubject);
          destination = `/?tab=profile#oauth_bound=${encodeURIComponent(providerId)}`;
        } else {
          const result = await userService.loginWithOAuth(
            providerId,
            identitySubject,
            {
              username: profile.handle || profile.preferred_username || profile.login,
              email: profile.email,
            },
            oauthState.flow,
          );
          destination = `/#oauth_token=${encodeURIComponent(result.token)}`;
        }
        redirectOAuthResult(res, destination, {
          "Set-Cookie": `rngdle_oauth_flow=; Path=${oauthCookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
      } catch (error) {
        console.error("OAuth callback failed:", error.message);
        const failure = error.status === 400 || error.status === 403 || error.status === 404 || error.status === 409
          ? error.message
          : "OAuth 登录失败，请稍后重试或联系管理员";
        redirectOAuthResult(res, `/?oauth_error=${encodeURIComponent(failure)}`, {
          "Set-Cookie": `rngdle_oauth_flow=; Path=${oauthCookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`,
        });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/auth/register") {
      throw new UserError(403, "网站注册仅支持 OAuth，请通过 OAuth 提供商创建账户");
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

    if (method === "PUT" && pathname === "/api/me/password") {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话修改密码");
      }
      const body = await parseBody(req);
      await userService.changePassword(
        user,
        body.currentPassword,
        body.newPassword,
        auth.tokenHash,
      );
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/me/oauth/")) {
      if (auth.kind !== "session") throw new UserError(403, "请使用网站登录会话管理 OAuth 绑定");
      const providerId = decodeURIComponent(pathname.slice("/api/me/oauth/".length));
      await userService.unlinkOAuthIdentity(username, providerId);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/admin/")) {
      userService.requireAdmin(auth);
      if (method === "GET" && pathname === "/api/admin/overview") {
        jsonResponse(res, 200, userService.adminOverview());
        return;
      }
      if (method === "GET" && pathname === "/api/admin/users") {
        jsonResponse(res, 200, { users: userService.listUsers() });
        return;
      }
      const adminUserMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
      if (adminUserMatch) {
        const targetUsername = decodeURIComponent(adminUserMatch[1]);
        if (method === "PATCH") {
          const body = await parseBody(req);
          const updated = await userService.updateUserAdmin(targetUsername, body, username);
          jsonResponse(res, 200, updated);
          return;
        }
        if (method === "DELETE") {
          if (targetUsername === username) throw new UserError(400, "不能删除当前登录账户");
          await userService.deleteUserAdmin(targetUsername);
          jsonResponse(res, 200, { ok: true });
          return;
        }
      }
      if (method === "GET" && pathname === "/api/admin/oauth/providers") {
        jsonResponse(res, 200, { providers: userService.listOAuthProviders() });
        return;
      }
      if (method === "POST" && pathname === "/api/admin/oauth/providers") {
        const body = await parseBody(req);
        jsonResponse(res, 201, { provider: await userService.saveOAuthProvider(body) });
        return;
      }
      const adminProviderMatch = /^\/api\/admin\/oauth\/providers\/([a-z0-9_-]+)$/.exec(pathname);
      if (adminProviderMatch) {
        const providerId = decodeURIComponent(adminProviderMatch[1]);
        if (method === "PUT") {
          const body = await parseBody(req);
          jsonResponse(res, 200, { provider: await userService.saveOAuthProvider(body, providerId) });
          return;
        }
        if (method === "DELETE") {
          await userService.deleteOAuthProvider(providerId);
          jsonResponse(res, 200, { ok: true });
          return;
        }
      }
      if (method === "GET" && pathname === "/api/admin/site-info") {
        jsonResponse(res, 200, userService.getSiteInfo());
        return;
      }
      if (method === "PUT" && pathname === "/api/admin/site-info") {
        jsonResponse(res, 200, await userService.updateSiteInfo(await parseBody(req)));
        return;
      }
    }

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

    const tokenConfigGroupMatch = /^\/api\/auth\/tokens\/([^/]+)\/config-groups\/([^/]+)$/.exec(pathname);
    if (tokenConfigGroupMatch && ["POST", "PUT"].includes(method)) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话管理 token 配置组");
      }
      const tokenId = decodeURIComponent(tokenConfigGroupMatch[1]);
      const game = decodeURIComponent(tokenConfigGroupMatch[2]);
      const body = await parseBody(req);
      if (method === "POST") {
        const group = await userService.createApiTokenConfigGroup(
          user,
          tokenId,
          game,
          body.name,
          body.config,
        );
        const { token } = userService.findApiToken(user, tokenId);
        if (game === "collection" && token.allowedGames.includes(game)) {
          scheduleCollectionWarmup(token.config, "Time Collection configuration group creation");
        }
        jsonResponse(res, 201, {
          group,
          configGroupIds: { ...token.configGroupIds },
          config: token.config,
        });
        return;
      }
      const result = await userService.assignApiTokenConfigGroup(user, tokenId, game, body.groupId);
      const { token } = userService.findApiToken(user, tokenId);
      if (game === "collection" && token.allowedGames.includes(game)) {
        scheduleCollectionWarmup(result.config, "Time Collection configuration group selection");
      }
      jsonResponse(res, 200, result);
      return;
    }

    const configGroupMatch = /^\/api\/auth\/config-groups\/([^/]+)$/.exec(pathname);
    if (method === "PUT" && configGroupMatch) {
      if (auth.kind !== "session") {
        throw new UserError(403, "请使用网站登录会话修改配置组");
      }
      const groupId = decodeURIComponent(configGroupMatch[1]);
      const group = await userService.updateConfigGroup(user, groupId, await parseBody(req));
      for (const token of Object.values(user.apiTokens)) {
        if (token.configGroupIds?.collection === group.id
            && token.allowedGames.includes("collection")) {
          scheduleCollectionWarmup(token.config, "Time Collection configuration group update");
        }
      }
      jsonResponse(res, 200, { group });
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

    const collectionNumberMatch = /^\/api\/games\/([0-9a-f-]+)\/collection-number$/.exec(pathname);
    if (method === "POST" && collectionNumberMatch) {
      const game = user.games[collectionNumberMatch[1]];
      if (!game) throw new UserError(404, "游戏不存在或不属于当前用户");
      if (auth.kind === "api" && game.tokenHash !== auth.tokenHash) {
        throw new UserError(403, "此游戏会话不属于当前 API token");
      }
      if (game.game !== "collection") {
        throw new UserError(400, "此接口仅适用于 Time Collection");
      }
      const token = user.apiTokens[game.tokenHash];
      if (!token) throw new UserError(404, "此游戏会话绑定的 API token 已撤销");
      if (!token.allowedGames.includes(game.game)) {
        throw new UserError(403, `此 API token 不允许访问 ${game.game}`);
      }
      let number;
      do {
        number = crypto.randomInt(0, 1_000_001);
      } while (!isUncommonNumber(number));
      const scoring = scoreNumber(
        number,
        userService.getTokenConfig(user, token).games.collection,
      );
      userService.recordApiUsage(user, game.game, "score");
      await userService.persist();
      jsonResponse(res, 200, {
        game_id: collectionNumberMatch[1],
        number,
        score: scoring.score,
        percentile: percentileForNumber(number),
        matched: scoring.matched,
        scoringBadges: scoring.scoringBadges,
      });
      return;
    }

    const collectionThresholdsMatch = /^\/api\/games\/([0-9a-f-]+)\/collection-thresholds$/.exec(pathname);
    if (method === "POST" && collectionThresholdsMatch) {
      const game = user.games[collectionThresholdsMatch[1]];
      if (!game) throw new UserError(404, "游戏不存在或不属于当前用户");
      if (auth.kind === "api" && game.tokenHash !== auth.tokenHash) {
        throw new UserError(403, "此游戏会话不属于当前 API token");
      }
      if (game.game !== "collection") {
        throw new UserError(400, "此接口仅适用于 Time Collection");
      }
      const token = user.apiTokens[game.tokenHash];
      if (!token) throw new UserError(404, "此游戏会话绑定的 API token 已撤销");
      if (!token.allowedGames.includes(game.game)) {
        throw new UserError(403, `此 API token 不允许访问 ${game.game}`);
      }
      const body = await parseBody(req);
      const thresholds = await getCollectionThresholdTable(
        userService.getTokenConfig(user, token),
        { turns: body.turns, slots: body.slots },
      );
      userService.recordApiUsage(user, game.game, "decision");
      await userService.persist();
      jsonResponse(res, 200, { game_id: collectionThresholdsMatch[1], thresholds });
      return;
    }

    const scoreMatch = /^\/api\/games\/([0-9a-f-]+)\/score$/.exec(pathname);
    if (method === "POST" && scoreMatch) {
      const game = user.games[scoreMatch[1]];
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
      if (!Number.isInteger(body.number) || body.number < 0 || body.number > 1_000_000) {
        throw new UserError(400, "number 必须是 0–1,000,000 范围内的整数");
      }
      const config = userService.getTokenConfig(user, token);
      const scoring = scoreNumber(body.number, config.games[game.game]);
      userService.recordApiUsage(user, game.game, "score");
      await userService.persist();
      jsonResponse(res, 200, { game_id: scoreMatch[1], number: body.number, ...scoring });
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
        const decision = await decide(game.game, body, userService.getTokenConfig(user, token));
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
