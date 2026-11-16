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
const { defaultConfig, FEATURES, isUncommonNumber, scoreNumber } = require("../games");

function findCommonNumber() {
  for (let number = 0; number <= 1_000_000; number++) {
    if (!isUncommonNumber(number)) return number;
  }
  throw new Error("No number below the Uncommon percentile cutoff was found");
}

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

test("Time Collection only generates and accepts Uncommon-or-higher numbers", async (t) => {
  const { api, users, user, sessionToken } = await createFixture(t);
  const collectionToken = await users.createApiToken(user, "collection-only", ["collection"]);
  const game = await request(api, "POST", "/api/games", collectionToken.token, { game: "collection" });
  const generated = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/collection-number`,
    collectionToken.token,
    {},
  );
  assert.equal(generated.status, 200);
  assert.equal(isUncommonNumber(generated.body.number), true);
  assert.ok(generated.body.percentile >= 50);

  const belowThresholdNumber = findCommonNumber();
  const commonNumber = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    collectionToken.token,
    { current: belowThresholdNumber, remainingTurns: 10, slotsRemaining: 3 },
  ).then((result) => result, (error) => ({ status: error.status, body: { error: error.message } }));
  assert.equal(commonNumber.status, 400);
  assert.match(commonNumber.body.error, /Uncommon or higher/);

  const allowedNumber = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    collectionToken.token,
    { current: generated.body.number, remainingTurns: 10, slotsRemaining: 3 },
  );
  assert.equal(allowedNumber.status, 200);
});

test("Time Collection threshold table provides optimal EP cutoffs for all positions", async (t) => {
  const { api, users, user } = await createFixture(t);
  const collectionToken = await users.createApiToken(user, "collection-only", ["collection"]);
  const game = await request(api, "POST", "/api/games", collectionToken.token, { game: "collection" });
  const result = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/collection-thresholds`,
    collectionToken.token,
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.thresholds.length, 30);
  assert.equal(result.body.thresholds[0].position, 1);
  assert.equal(result.body.thresholds[0].bySlotsRemaining[5].action, "threshold");
  assert.equal(Number.isSafeInteger(result.body.thresholds[0].bySlotsRemaining[5].requiredEp), true);
  assert.equal(result.body.thresholds[0].bySlotsRemaining[5].forced, false);
  assert.deepEqual(result.body.thresholds[29].bySlotsRemaining[1], {
    action: "take",
    requiredEp: null,
    forced: true,
  });

  // Overtime (12 turns) and arbitrary lengths are supported via the `turns` body.
  const overtime = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/collection-thresholds`,
    collectionToken.token,
    { turns: 12 },
  );
  assert.equal(overtime.status, 200);
  assert.equal(overtime.body.thresholds.length, 12);
  assert.equal(overtime.body.thresholds[0].remainingTurns, 12);
  assert.equal(overtime.body.thresholds[11].remainingTurns, 1);

  const custom = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/collection-thresholds`,
    collectionToken.token,
    { turns: 7, slots: 4 },
  );
  assert.equal(custom.status, 200);
  assert.equal(custom.body.thresholds.length, 7);
  assert.equal(custom.body.thresholds[0].bySlotsRemaining.length, 5);
});

test("Digit Climb API returns five solutions and validates a submitted answer's budget", async (t) => {
  const { api, users, user } = await createFixture(t);
  const climbToken = await users.createApiToken(user, "climb-only", ["climb"]);
  const game = await request(api, "POST", "/api/games", climbToken.token, { game: "climb" });
  const result = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    climbToken.token,
    { number: 314159, budget: 3, answer: 314169 },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.decision.solutions.length, 5);
  assert.equal(result.body.decision.answer.cost, 1);
  const shortStartResult = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    climbToken.token,
    { number: 60451, budget: 3, answer: 60451 },
  );
  assert.equal(shortStartResult.body.decision.answer.cost, 0);
  const invalidAnswer = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    climbToken.token,
    { number: 314159, budget: 3, answer: 999999 },
  ).then((value) => value, (error) => ({ status: error.status }));
  assert.equal(invalidAnswer.status, 400);
});

test("Digit Poker API constructs best EP arrangement and returns betting advice", async (t) => {
  const { api, users, user } = await createFixture(t);
  const pokerToken = await users.createApiToken(user, "poker-only", ["poker"]);
  const game = await request(api, "POST", "/api/games", pokerToken.token, { game: "poker" });
  const construct = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    pokerToken.token,
    { mode: "construct", private: [1, 4, 8], shared: [0, 2, 3, 5, 9] },
  );
  assert.equal(construct.status, 200);
  assert.equal(construct.body.decision.game, "poker");
  assert.equal(construct.body.decision.best.digits.length, 6);
  assert.equal(construct.body.decision.best.arrangement[1][0], "p");
  assert.equal(construct.body.decision.best.arrangement[4][0], "p");

  const bet = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    pokerToken.token,
    { mode: "bet", private: [9, 9, 8], shared: [9, 9, 8], toCall: 100, pot: 600, stack: 5000 },
  );
  assert.equal(bet.status, 200);
  assert.ok(["fold", "check", "call", "raise", "allin"].includes(bet.body.decision.action));

  const wrongGame = await request(
    api,
    "POST",
    `/api/games/${game.body.game_id}/decide`,
    pokerToken.token,
    { mode: "construct", private: [1, 2], shared: [0, 1, 2, 3, 4] },
  ).then((value) => value, (error) => ({ status: error.status }));
  assert.equal(wrongGame.status, 400);
});

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
  const score = await request(
    api,
    "POST",
    `/api/games/${compositionGame.body.game_id}/score`,
    compositionToken.token,
    { number: 314159 },
  );
  assert.equal(score.status, 200);
  assert.equal(typeof score.body.score, "number");
  assert.ok(Array.isArray(score.body.matched));
  const crossTokenScore = await request(
    api,
    "POST",
    `/api/games/${compositionGame.body.game_id}/score`,
    targetToken.token,
    { number: 314159 },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(crossTokenScore.status, 403);
  const invalidScore = await request(
    api,
    "POST",
    `/api/games/${compositionGame.body.game_id}/score`,
    compositionToken.token,
    { number: 1.5 },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(invalidScore.status, 400);

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
  assert.equal(measured.body.games.composition.apiCalls, 3);
  assert.equal(measured.body.games.composition.decisions, 1);
  assert.equal(measured.body.games.composition.games, 1);
  assert.equal(measured.body.games.composition.frequency.hour, 3);
  assert.equal(measured.body.games.composition.frequency.day, 3);
  assert.equal(measured.body.games.composition.frequency.month, 3);
  assert.equal(measured.body.games.composition.frequency.year, 3);
  assert.equal(measured.body.games.target.apiCalls, 1);
  assert.equal(measured.body.games.target.decisions, 0);
  assert.equal(measured.body.games.target.games, 1);
  assert.equal(measured.body.total.apiCalls, 4);
  assert.equal(measured.body.total.decisions, 1);
  assert.equal(measured.body.total.games, 2);
  assert.equal(measured.body.total.frequency.day, 4);
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
  const compositionGame = await request(
    api,
    "POST",
    "/api/games",
    compositionToken.token,
    { game: "composition" },
  );
  const score = await request(
    api,
    "POST",
    `/api/games/${compositionGame.body.game_id}/score`,
    compositionToken.token,
    { number: 314159 },
  );
  assert.equal(score.body.score, 0);
  const apiProfile = await request(api, "GET", "/api/me", compositionToken.token);
  assert.deepEqual(apiProfile.body.apiTokens.map(({ id }) => id), [compositionToken.id]);
  assert.equal(apiProfile.body.configGroups.length, 6);

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

test("API tokens receive per-game groups and can reuse one group across tokens and modes", async (t) => {
  const { api, sessionToken, compositionToken, targetToken } = await createFixture(t);
  const initialProfile = await request(api, "GET", "/api/me", sessionToken);
  assert.equal(initialProfile.body.configGroups.length, 12);
  const compositionApi = initialProfile.body.apiTokens.find(({ id }) => id === compositionToken.id);
  const targetApi = initialProfile.body.apiTokens.find(({ id }) => id === targetToken.id);
  assert.deepEqual(Object.keys(compositionApi.configGroupIds).sort(), ["claim", "climb", "collection", "composition", "poker", "target"]);
  assert.equal(new Set(Object.values(compositionApi.configGroupIds)).size, 6);

  const compositionGroupId = compositionApi.configGroupIds.composition;
  const updateGroup = await request(
    api,
    "PUT",
    `/api/auth/config-groups/${compositionGroupId}`,
    sessionToken,
    { config: { knowledge: { PRIME: { known: false } } } },
  );
  assert.equal(updateGroup.body.group.config.knowledge.PRIME.known, false);

  const crossModeSelection = await request(
    api,
    "PUT",
    `/api/auth/tokens/${targetToken.id}/config-groups/target`,
    sessionToken,
    { groupId: compositionGroupId },
  );
  assert.equal(crossModeSelection.status, 200);
  const secondModeSelection = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}/config-groups/target`,
    sessionToken,
    { groupId: compositionGroupId },
  );
  assert.equal(secondModeSelection.status, 200);
  const profile = await request(api, "GET", "/api/me", sessionToken);
  const updatedCompositionApi = profile.body.apiTokens.find(({ id }) => id === compositionToken.id);
  const updatedTargetApi = profile.body.apiTokens.find(({ id }) => id === targetToken.id);
  assert.equal(updatedCompositionApi.config.games.composition.knowledge.PRIME.known, false);
  assert.equal(updatedTargetApi.config.games.target.knowledge.PRIME.known, false);
  assert.equal(updatedTargetApi.config.games.composition.knowledge.PRIME.known, true);
  assert.equal(
    updatedTargetApi.configGroupIds.target,
    updatedCompositionApi.configGroupIds.target,
  );
  assert.equal(
    updatedCompositionApi.configGroupIds.composition,
    updatedCompositionApi.configGroupIds.target,
  );
  const conflictingLegacyConfig = defaultConfig();
  conflictingLegacyConfig.games.target.knowledge.PRIME = { known: false };
  const rejectedLegacyUpdate = await request(
    api,
    "PUT",
    `/api/auth/tokens/${compositionToken.id}/config`,
    sessionToken,
    { config: conflictingLegacyConfig },
  ).then((result) => result, (error) => ({ status: error.status }));
  assert.equal(rejectedLegacyUpdate.status, 400);
  await request(
    api,
    "PUT",
    `/api/auth/config-groups/${compositionGroupId}`,
    sessionToken,
    { config: { knowledge: { PRIME: { known: true }, ODD: { known: false } } } },
  );
  const updatedProfile = await request(api, "GET", "/api/me", sessionToken);
  const sharedCompositionApi = updatedProfile.body.apiTokens.find(({ id }) => id === compositionToken.id);
  const sharedTargetApi = updatedProfile.body.apiTokens.find(({ id }) => id === targetToken.id);
  assert.equal(sharedCompositionApi.config.games.composition.knowledge.ODD.known, false);
  assert.equal(sharedCompositionApi.config.games.target.knowledge.ODD.known, false);
  assert.equal(sharedTargetApi.config.games.target.knowledge.ODD.known, false);
  const targetGame = await request(
    api,
    "POST",
    "/api/games",
    targetToken.token,
    { game: "target" },
  );
  const targetScore = await request(
    api,
    "POST",
    `/api/games/${targetGame.body.game_id}/score`,
    targetToken.token,
    { number: 314159 },
  );
  assert.equal(targetScore.body.score, scoreNumber(314159, sharedTargetApi.config.games.target).score);
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
  assert.equal(Object.keys(migrated.users.legacy.configGroups).length, 6);
  assert.equal(Object.keys(metadata.configGroupIds).length, 6);
  assert.equal(Object.hasOwn(migrated.users.legacy, "pendingConfigMigration"), false);
});

test("existing API tokens migrate to three separate configuration groups each", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rngdle-token-group-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "store.json");
  const firstConfig = defaultConfig();
  firstConfig.games.composition.knowledge.PRIME = { known: false };
  const secondConfig = defaultConfig();
  secondConfig.games.collection.knowledge.ODD = { known: false };
  await fs.writeFile(dataFile, JSON.stringify({
    version: 1,
    users: {
      existing: {
        sessions: {},
        apiTokens: {
          first: {
            id: "first-token",
            label: "first",
            allowedGames: ["composition"],
            config: firstConfig,
          },
          second: {
            id: "second-token",
            label: "second",
            allowedGames: ["collection"],
            config: secondConfig,
          },
        },
        games: {},
      },
    },
  }));
  const users = createUserService(dataFile);
  await users.load();
  const persisted = JSON.parse(await fs.readFile(dataFile, "utf8"));
  const migratedUser = persisted.users.existing;
  assert.equal(Object.keys(migratedUser.configGroups).length, 12);
  for (const token of Object.values(migratedUser.apiTokens)) {
    assert.equal(Object.keys(token.configGroupIds).length, 6);
    assert.equal(new Set(Object.values(token.configGroupIds)).size, 6);
  }
  assert.equal(
    migratedUser.apiTokens.first.config.games.composition.knowledge.PRIME.known,
    false,
  );
  assert.equal(
    migratedUser.apiTokens.second.config.games.collection.knowledge.ODD.known,
    false,
  );
});
