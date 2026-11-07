"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeNumber,
  features,
  isUncommonNumber,
  percentileForNumber,
  scoreKnownBadges,
  createKnownBadgeScorer,
} = require("../official-engine");
const {
  defaultConfig,
  normalizeConfig,
  scoreNumber,
  computeOptimalThresholds,
  decide,
  prewarmCollection,
} = require("../games");

function findCommonNumber() {
  for (let number = 0; number <= 1_000_000; number++) {
    if (!isUncommonNumber(number)) return number;
  }
  throw new Error("No number below the Uncommon percentile cutoff was found");
}

test("official calculator produces the game's exact score and percentile", () => {
  const result = analyzeNumber(314_159);
  assert.equal(result.totalScore, 25_007_367);
  assert.equal(result.scoringBadges.length > 0, true);
});

test("all known badges reproduce the official scoring engine total", () => {
  const config = defaultConfig().games.composition;
  const result = scoreNumber(314_159, config);
  assert.equal(result.score, analyzeNumber(314_159).totalScore);
});

test("partial knowledge adjustment matches direct official badge scoring", () => {
  const known = new Set(features
    .filter(({ id }) => !["VOID", "ODD", "LIFTOFF", "HILLS"].includes(id))
    .map(({ id }) => id));
  const scoreKnown = createKnownBadgeScorer(known);
  for (const number of [0, 69, 123, 314_151, 314_159, 999_999, 1_000_000]) {
    assert.equal(scoreKnown(number), scoreKnownBadges(number, known).score);
  }
});

test("unknown official high-score badges are excluded from the computed score", () => {
  const number = 69;
  const analysis = analyzeNumber(number);
  const badgeId = analysis.scoringBadges[0];
  const config = defaultConfig().games.composition;
  for (const feature of features) config.knowledge[feature.id] = { known: false };
  config.knowledge[badgeId] = { known: true };

  const result = scoreNumber(number, config);
  assert.equal(result.score, features.find((feature) => feature.id === badgeId).score);
  assert.deepEqual(result.scoringBadges, [badgeId]);
  assert.ok(result.score < analysis.totalScore);
});

test("knowledge settings are independent between games", () => {
  const config = normalizeConfig({
    games: {
      collection: { knowledge: { PRIME: { known: false } } },
    },
  });
  assert.equal(config.games.collection.knowledge.PRIME.known, false);
  assert.equal(config.games.composition.knowledge.PRIME.known, true);
  assert.equal(config.games.target.knowledge.PRIME.known, true);
  assert.equal(config.games.climb.knowledge.PRIME.known, true);
});

test("Digit Composition enumerates legal key positions and uses official badge scoring", async () => {
  const config = defaultConfig();
  const result = await decide("composition", {
    key: [1, 4, 8],
    open: [0, 2, 3, 5, 9],
  }, config);
  assert.equal(result.digits.length, 6);
  assert.equal(result.arrangement[1][0], "k");
  assert.equal(result.arrangement[4][0], "k");
  assert.notEqual(result.arrangement[1], result.arrangement[4]);
  assert.equal(new Set(result.arrangement).size, 6);
  assert.equal(result.score, analyzeNumber(result.number).totalScore);
});

test("Digit Composition accepts and preserves a leading zero", async () => {
  const result = await decide("composition", {
    key: [0, 0, 0],
    open: [0, 0, 0, 0, 0],
  }, defaultConfig());
  assert.equal(result.digits, "000000");
  assert.equal(result.number, 0);
  assert.equal(result.arrangement[1][0], "k");
  assert.equal(result.arrangement[4][0], "k");
});

test("Time Collection uses exact optimal thresholds and never replaces an accepted number", async () => {
  assert.equal(isUncommonNumber(314_159), true);
  assert.ok(percentileForNumber(314_159) >= 50);
  const commonNumber = findCommonNumber();
  assert.equal(isUncommonNumber(commonNumber), false);
  await assert.rejects(
    () => decide("collection", {
      current: commonNumber,
      remainingTurns: 10,
      slotsRemaining: 3,
    }, defaultConfig()),
    /Uncommon or higher/,
  );
  const config = defaultConfig();
  const forced = await decide("collection", {
    current: 314_159,
    remainingTurns: 2,
    slotsRemaining: 2,
  }, config);
  assert.equal(forced.action, "take");
  assert.equal(forced.forced, true);

  const full = await decide("collection", {
    current: 314_159,
    remainingTurns: 10,
    slotsRemaining: 0,
  }, config);
  assert.equal(full.action, "skip");
  assert.equal(Object.hasOwn(full, "replace"), false);
});

test("Time Collection derives its score distribution from the user's JavaScript scoring config", async () => {
  const config = defaultConfig();
  for (const feature of features) config.games.collection.knowledge[feature.id] = { known: false };
  const decision = await decide("collection", {
    current: 314_159,
    remainingTurns: 3,
    slotsRemaining: 1,
  }, config);
  assert.equal(decision.score, 0);
  assert.equal(decision.threshold, 0);
  assert.equal(decision.action, "take");
});

test("Time Collection prewarming shares the personalized distribution with later decisions", async () => {
  const config = defaultConfig();
  for (const feature of features) config.games.collection.knowledge[feature.id] = { known: false };
  const firstWarmup = prewarmCollection(config);
  assert.equal(firstWarmup, prewarmCollection(config));
  await firstWarmup;

  const decision = await decide("collection", {
    current: 314_159,
    remainingTurns: 3,
    slotsRemaining: 1,
  }, config);
  assert.equal(decision.score, 0);
  assert.equal(decision.threshold, 0);
});

test("optimal stopping thresholds use the exact finite-horizon recurrence", () => {
  const thresholds = computeOptimalThresholds([0, 10, 20, 30], 3, 1);
  assert.equal(thresholds[1][1], Number.NEGATIVE_INFINITY);
  assert.equal(thresholds[2][1], 15);
  assert.equal(thresholds[3][1], 20);
});

test("Target Chase changes exactly one legal digit and minimizes known-score distance", async () => {
  const result = await decide("target", { number: 314_159, target: 27_182_800 }, defaultConfig());
  const before = String(314_159);
  const after = String(result.result);
  assert.equal(before.length, after.length);
  assert.equal(before.split("").filter((digit, index) => digit !== after[index]).length, 1);
  assert.equal(Number(after[result.position]), result.replacement);
  assert.equal(result.score, analyzeNumber(result.result).totalScore);
});

test("Digit Climb returns five highest-scoring reachable six-digit numbers within budget", async () => {
  const config = defaultConfig();
  const result = await decide(
    "climb",
    { number: 314159, budget: 3, answer: 314169 },
    config,
  );
  assert.equal(result.game, "climb");
  assert.equal(result.solutions.length, 5);
  assert.ok(result.solutions.some(({ number, cost }) => number === 314159 && cost === 0));
  assert.ok(result.solutions.every(({ number, cost, score }) =>
    number >= 0 && number <= 999999 && cost <= 3 && Number.isSafeInteger(score)));
  assert.ok(result.solutions.every(({ number, score }) =>
    score === scoreNumber(number, config.games.climb).score));
  for (let index = 1; index < result.solutions.length; index++) {
    const previous = result.solutions[index - 1];
    const current = result.solutions[index];
    assert.ok(previous.score > current.score
      || (previous.score === current.score && previous.cost < current.cost)
      || (previous.score === current.score && previous.cost === current.cost && previous.number > current.number));
  }
  assert.equal(result.answer.number, 314169);
  assert.equal(result.answer.cost, 1);
  await assert.rejects(
    () => decide("climb", { number: 314159, budget: 3, answer: 999999 }, config),
    /cannot be reached within budget/,
  );
  await assert.rejects(
    () => decide("climb", { number: 314159, budget: 4 }, config),
    /budget must be one of 3, 5, 7/,
  );
  await assert.rejects(
    () => decide("climb", { number: 1_000_000, budget: 3 }, config),
    /between 0 and 999999/,
  );
});

test("Digit Climb pads short room numbers to six digits and validates padded answers", async () => {
  const config = defaultConfig();
  const result = await decide(
    "climb",
    { number: 60451, budget: 3, answer: 60451 },
    config,
  );
  assert.equal(result.number, 60451);
  assert.equal(result.answer.number, 60451);
  assert.equal(result.answer.cost, 0);
  assert.ok(result.solutions.some(({ number, cost }) => number === 60451 && cost === 0));
});

test("decisions reject unknown games and malformed game inputs", async () => {
  await assert.rejects(() => decide("poker", {}, defaultConfig()), /Unknown game/);
  await assert.rejects(() => decide("composition", {
    key: [1, 2],
    open: [0, 1, 2, 3, 4],
  }, defaultConfig()), /exactly 3/);
  await assert.rejects(() => decide("collection", {
    current: 314_159,
    remainingTurns: 2,
    slotsRemaining: 3,
  }, defaultConfig()), /slotsRemaining/);
  await assert.rejects(
    () => decide("target", { number: 314_159, target: 12.5 }, defaultConfig()),
    /integer between 0 and/,
  );
  await assert.rejects(
    () => decide("target", { number: 1_000_001, target: 0 }, defaultConfig()),
    /between 0 and 1000000/,
  );
});
