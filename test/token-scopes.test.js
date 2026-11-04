"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createApiHandler } = require("../api");
const { createUserService } = require("../users");
const { defaultConfig, FEATURES } = require("../games");

function createResponse() {
  return {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function request(api, method, pathname, token, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = createResponse();
  return api.handle(req, response, new URL(`http://localhost${pathname}`))
    .then(() => ({ status: response.status, body: JSON.parse(response.body || "{}") }));
}

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rngdle-token-scope-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "store.json");
  const users = createUserService(dataFile);
  await users.load();
  const api = createApiHandler(users);
  const registration = await users.register({ username: "token_user", password: "long-test-password" });
  const sessionToken = registration.token;
  const user = users.authenticate({ headers: { authorization: `Bearer ${sessionToken}` } }).user;
  const compositionToken = await users.createApiToken(
    user,
    "composition-only",
    ["composition"],
  );
  const targetToken = await users.createApiToken(
    user,
    "target-only",
    ["target"],
  );
  return { api, dataFile, users, user, sessionToken, compositionToken, targetToken };
}

test("personal usage statistics default to zero and count per-game API usage", async (t) => {
  const { api, dataFile, sessionToken, compositionToken, targetToken } = await createFixture(t);
  const initial = await request(api, "GET", "/api/me/stats", sessionToken);
  assert.equal(initial.body.tokenCount, 2);
  assert.equal(initial.body.total.apiCalls, 0);
  assert.equal(initial.body.total.decisions, 0);
  assert.equal(initial.body.total.games, 0);
  assert.equal(initial.body.games.composition.frequency.hour, 0);

  const tokenAccess = await request(api, "GET", "/api/me/stats", compositionToken.token)
    .then((result) => result, (error) => ({ status: error.status }));
  assert.equal(tokenAccess.status, 403);

  const compositionGame = await request(
    api,
    "POST",
    "/api/games",
    compositionToken.token,
    { game: "composition" },
  );
  await request(
    api,
    "POST",
    `/api/games/${compositionGame.body.game_id}/decide`,
    compositionToken.token,
    { key: [1, 4, 8], open: [0, 2, 3, 5, 9] },
  );
  await request(
    api,
    "POST",
    "/api/games",
    targetToken.token,
    { game: "target" },
  );

  const measured = await request(api, "GET", "/api/me/stats", sessionToken);
  assert.equal(measured.body.games.composition.apiCalls, 2);
  assert.equal(measured.body.games.composition.decisions, 1);
  assert.equal(measured.body.games.composition.games, 1);
  assert.equal(measured.body.games.composition.frequency.hour, 2);
  assert.equal(measured.body.games.composition.frequency.day, 2);
  assert.equal(measured.body.games.composition.frequency.month, 2);
  assert.equal(measured.body.games.composition.frequency.year, 2);
  assert.equal(measured.body.games.target.apiCalls, 1);
  assert.equal(measured.body.games.target.decisions, 0);
  assert.equal(measured.body.games.target.games, 1);
  assert.equal(measured.body.total.apiCalls, 3);
  assert.equal(measured.body.total.decisions, 1);
  assert.equal(measured.body.total.games, 2);
  assert.equal(measured.body.total.frequency.day, 3);
  const persisted = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(persisted.users.token_user.usageStats.games.composition.decisions, 1);
  assert.equal(persisted.users.token_user.usageStats.games.target.games, 1);
});

test("API token settings and allowed games are isolated per token", async (t) => {
  const { api, users, user, sessionToken, compositionToken, targetToken } = await createFixture(t);
  const emptyKnowledge = Object.fromEntries(FEATURES.map(({ id }) => [id, { known: false }]));
  const update = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}/config`,
    sessionToken,
    { config: { games: { composition: { knowledge: emptyKnowledge } } } },
  );
  assert.equal(update.status, 200);

  const profile = await request(api, "GET", "/api/me", sessionToken);
  const compositionConfig = profile.body.apiTokens.find(({ id }) => id === compositionToken.id).config;
  const targetConfig = profile.body.apiTokens.find(({ id }) => id === targetToken.id).config;
  assert.equal(compositionConfig.games.composition.knowledge.PRIME.known, false);
  assert.equal(targetConfig.games.composition.knowledge.PRIME.known, true);
  const apiProfile = await request(api, "GET", "/api/me", compositionToken.token);
  assert.deepEqual(apiProfile.body.apiTokens.map(({ id }) => id), [compositionToken.id]);

  const forbidden = await request(
    api,
    "POST",
    "/api/games",
    compositionToken.token,
    { game: "target" },
  ).then((result) => result, (error) => ({ status: error.status, body: { error: error.message } }));
  assert.equal(forbidden.status, 403);

  const created = await request(
    api,
    "POST",
    "/api/games",
    compositionToken.token,
    { game: "composition" },
  );
  assert.equal(created.status, 201);

  const decision = await request(
    api,
    "POST",
    `/api/games/${created.body.game_id}/decide`,
    compositionToken.token,
    { key: [1, 4, 8], open: [0, 2, 3, 5, 9] },
  );
  assert.equal(decision.status, 200);
  assert.equal(decision.body.decision.score, 0);

  const crossTokenDecision = await request(
    api,
    "POST",
    `/api/games/${created.body.game_id}/decide`,
    targetToken.token,
    { key: [1, 4, 8], open: [0, 2, 3, 5, 9] },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(crossTokenDecision.status, 403);

  const sessionGame = await request(
    api,
    "POST",
    "/api/games",
    sessionToken,
    { game: "composition", tokenId: compositionToken.id },
  );
  assert.equal(sessionGame.status, 201);
  const sessionDenied = await request(
    api,
    "POST",
    "/api/games",
    sessionToken,
    { game: "target", tokenId: compositionToken.id },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(sessionDenied.status, 403);

  const scopeUpdate = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}/games`,
    sessionToken,
    { allowedGames: ["target"] },
  );
  assert.deepEqual(scopeUpdate.body.allowedGames, ["target"]);
  const afterScopeRevocation = await request(
    api,
    "POST",
    `/api/games/${created.body.game_id}/decide`,
    compositionToken.token,
    { key: [1, 4, 8], open: [0, 2, 3, 5, 9] },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(afterScopeRevocation.status, 403);

  const compositionHash = crypto.createHash("sha256").update(compositionToken.token).digest("hex");
  assert.equal(user.apiTokens[compositionHash].config.games.composition.knowledge.PRIME.known, false);
});

test("API token details can be edited and rotated without losing configuration or game sessions", async (t) => {
  const { api, sessionToken, compositionToken } = await createFixture(t);
  const config = defaultConfig();
  config.games.composition.knowledge.PRIME = { known: false };
  await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}/config`,
    sessionToken,
    { config },
  );
  const game = await request(
    api,
    "POST",
    "/api/games",
    compositionToken.token,
    { game: "composition" },
  );
  assert.equal(game.status, 201);

  const invalidUpdate = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}`,
    sessionToken,
    { label: "should-not-save", allowedGames: [] },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(invalidUpdate.status, 400);
  const unchangedAfterInvalidUpdate = await request(api, "GET", "/api/me", sessionToken);
  assert.equal(
    unchangedAfterInvalidUpdate.body.apiTokens.find(({ id }) => id === compositionToken.id).label,
    "composition-only",
  );

  const update = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}`,
    sessionToken,
    { label: "renamed client", allowedGames: ["composition"] },
  );
  assert.equal(update.status, 200);
  assert.equal(update.body.label, "renamed client");

  const rotation = await request(
    api,
    "POST",
    `/api/auth/tokens/${compositionToken.id}/rotate`,
    sessionToken,
    {},
  );
  assert.equal(rotation.status, 200);
  assert.equal(rotation.body.id, compositionToken.id);
  assert.equal(rotation.body.label, "renamed client");
  assert.deepEqual(rotation.body.allowedGames, ["composition"]);
  assert.notEqual(rotation.body.token, compositionToken.token);

  const oldTokenProfile = await request(api, "GET", "/api/me", compositionToken.token)
    .then((result) => result, (error) => ({ status: error.status }));
  assert.equal(oldTokenProfile.status, 401);

  const newTokenProfile = await request(api, "GET", "/api/me", rotation.body.token);
  const rotatedToken = newTokenProfile.body.apiTokens[0];
  assert.equal(rotatedToken.label, "renamed client");
  assert.deepEqual(rotatedToken.allowedGames, ["composition"]);
  assert.equal(rotatedToken.config.games.composition.knowledge.PRIME.known, false);
  assert.ok(rotatedToken.rotatedAt);

  const continuedGame = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    rotation.body.token,
    { key: [1, 4, 8], open: [0, 2, 3, 5, 9] },
  );
  assert.equal(continuedGame.status, 200);
});

test("legacy account configuration migrates to the first token when none existed", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rngdle-token-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "store.json");
  const legacyConfig = defaultConfig();
  legacyConfig.games.composition.knowledge.PRIME = { known: false };
  await fs.writeFile(dataFile, JSON.stringify({
    version: 1,
    users: {
      legacy: {
        config: legacyConfig,
        sessions: {
          [crypto.createHash("sha256").update("migration-session").digest("hex")]: {
            expiresAt: Date.now() + 60_000,
          },
        },
        apiTokens: {},
        games: {},
      },
    },
  }));
  const users = createUserService(dataFile);
  await users.load();
  const persisted = JSON.parse(await fs.readFile(dataFile, "utf8"));
  assert.equal(Object.hasOwn(persisted.users.legacy, "config"), false);
  const legacyUser = users.authenticate({ headers: { authorization: "Bearer migration-session" } }).user;
  const token = await users.createApiToken(legacyUser, "migrated", ["composition"]);
  const migrated = JSON.parse(await fs.readFile(dataFile, "utf8"));
  const metadata = Object.values(migrated.users.legacy.apiTokens)[0];
  assert.equal(metadata.id, token.id);
  assert.equal(metadata.config.games.composition.knowledge.PRIME.known, false);
  assert.equal(Object.hasOwn(migrated.users.legacy, "pendingConfigMigration"), false);
});
