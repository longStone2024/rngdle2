"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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
  getCollectionThresholdTable,
  setThresholdCacheDirectory,
} = require("../games");

function findCommonNumber() {
  for (let number = 0; number <= 1_000_000; number++) {
    if (!isUncommonNumber(number)) return number;
  }
  throw new Error("No number below the Uncommon percentile cutoff was found");
}

const CLAIM_ORDER = "ABBAABBAABBAAB";

function applyClaimPlacement(side, placement, digit) {
  const fixed = side.fixed.slice();
  let free = side.free;
  if (placement.moveFreeTo !== null && placement.moveFreeTo !== undefined) {
    fixed[placement.moveFreeTo] = free;
    free = null;
  }
  if (placement.placeFree) {
    free = digit;
  } else if (placement.placeSlot !== null && placement.placeSlot !== undefined) {
    fixed[placement.placeSlot] = digit;
  }
  return { fixed, free };
}

function claimsRemainingFromOrder(order, index, player) {
  let count = 0;
  for (let position = index; position < order.length; position += 1) {
    if (order[position] === player) count += 1;
  }
  return count;
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

test("Time Collection supports 12-turn overtime and arbitrary turn/slot counts", async () => {
  const config = defaultConfig();
  // 12-turn overtime decision must be accepted (not rejected as >30 turns).
  const overtime = await decide("collection", {
    current: 314_159,
    remainingTurns: 12,
    slotsRemaining: 3,
  }, config);
  assert.equal(overtime.game, "collection");
  assert.ok(["take", "skip"].includes(overtime.action));

  // Overtime threshold table has exactly 12 positions.
  const table = await getCollectionThresholdTable(config, { turns: 12 });
  assert.equal(table.length, 12);
  assert.equal(table[0].position, 1);
  assert.equal(table[0].remainingTurns, 12);
  assert.equal(table[11].remainingTurns, 1);

  // Arbitrary-length tables are also supported.
  const custom = await getCollectionThresholdTable(config, { turns: 7, slots: 4 });
  assert.equal(custom.length, 7);
  assert.equal(custom[0].bySlotsRemaining.length, 5); // slots+1 columns

  // Out-of-range turn counts are rejected.
  await assert.rejects(
    () => decide("collection", { current: 1, remainingTurns: 999, slotsRemaining: 1 }, config),
    /remainingTurns must be an integer between 1 and 200/,
  );
});

test("Time Collection persists DP thresholds and reloads them from disk", async (t) => {  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rngdle-collection-dp-"));
  t.after(async () => {
    setThresholdCacheDirectory();
    await fs.rm(directory, { recursive: true, force: true });
  });
  setThresholdCacheDirectory(directory);

  const config = defaultConfig();
  for (const feature of features) config.games.collection.knowledge[feature.id] = { known: false };
  const firstThresholds = await prewarmCollection(config);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8"));
  assert.equal(persisted.version, 2);
  assert.ok(Array.isArray(persisted.thresholds));

  setThresholdCacheDirectory(directory);
  const loadedThresholds = await prewarmCollection(config);
  assert.deepEqual(loadedThresholds, firstThresholds);
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
  const swapped = await decide(
    "climb",
    { number: 314159, budget: 3.5, answer: 341159 },
    config,
  );
  assert.equal(swapped.answer.cost, 1.5);
  await assert.rejects(
    () => decide("climb", { number: 314159, budget: 3, answer: 999999 }, config),
    /cannot be reached within budget/,
  );
  await assert.rejects(
    () => decide("climb", { number: 314159, budget: 4 }, config),
    /budget must be one of 3, 3.5, 5, 5.5, 7, 7.5/,
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
  assert.ok(result.solutions.length > 0);
});

test("Digit Poker constructs the highest-EP six-slot arrangement with private slots 2 and 5", async () => {
  const config = defaultConfig();
  const result = await decide("poker", {
    mode: "construct",
    private: [1, 4, 8],
    shared: [0, 2, 3, 5, 9],
  }, config);
  assert.equal(result.game, "poker");
  assert.equal(result.best.digits.length, 6);
  assert.equal(result.best.arrangement.length, 6);
  // Slots 2 and 5 (index 1 and 4) must carry private tokens.
  assert.equal(result.best.arrangement[1][0], "p");
  assert.equal(result.best.arrangement[4][0], "p");
  assert.notEqual(result.best.arrangement[1], result.best.arrangement[4]);
  assert.equal(new Set(result.best.arrangement).size, 6);
  assert.equal(result.best.score, analyzeNumber(result.best.number).totalScore);
  // The returned score must equal the best over all legal arrangements.
  const { solveConstruction } = require("../games/digit-poker");
  const known = new Set(require("../official-engine").features.map(({ id }) => id));
  const exhaustive = solveConstruction([1, 4, 8], [0, 2, 3, 5, 9], require("../games").POKER_RULES, known, null, false);
  assert.equal(result.best.score, exhaustive.score);
  assert.equal(result.best.number, exhaustive.number);
});

test("Digit Poker returns the lowest-EP legal completion when slots are fixed", async () => {
  const config = defaultConfig();
  const result = await decide("poker", {
    mode: "construct",
    private: [1, 4, 8],
    shared: [0, 2, 3, 5, 9],
    fixed: [9, null, 8, null, null, null],
  }, config);
  assert.equal(result.completion.digits.length, 6);
  assert.equal(result.completion.digits[0], "9");
  assert.equal(result.completion.digits[2], "8");
  assert.equal(result.completion.arrangement[1][0], "p");
  assert.equal(result.completion.arrangement[4][0], "p");
  // Fixed slots must be respected.
  assert.equal(result.completion.digits[0], "9");
  assert.equal(result.completion.digits[2], "8");
});

test("Digit Poker betting returns a valid action with strength estimate", async () => {
  const config = defaultConfig();
  const result = await decide("poker", {
    mode: "bet",
    private: [9, 9, 8],
    shared: [9, 9, 8, 7, 6],
    toCall: 100,
    pot: 600,
    stack: 5000,
    bigBlind: 100,
    minRaiseTo: 200,
    opponentsActive: 2,
  }, config);
  assert.equal(result.game, "poker");
  assert.equal(result.mode, "bet");
  assert.ok(["fold", "check", "call", "raise", "allin"].includes(result.action));
  assert.ok(Number.isFinite(result.strength.percentile));
  assert.ok(result.strength.score >= 0);
});

test("Digit Poker betting strength ranks against achievable hands, not all integers", async () => {
  const config = defaultConfig();
  // A mediocre preflop hand must NOT look elite (the old percentileForScore
  // saturated at ~99% for every optimized hand, causing constant all-ins).
  const weak = await decide("poker", {
    mode: "bet",
    private: [1, 4, 8],
    shared: [],
    toCall: 100,
    pot: 150,
    stack: 10000,
    bigBlind: 100,
    minRaiseTo: 200,
    currentBet: 100,
    opponentsActive: 2,
  }, config);
  assert.ok(weak.strength.floor < 50, `preflop floor should be weak, got ${weak.strength.floor}`);
  assert.ok(weak.strength.ceiling <= 100);
  assert.equal(["fold", "call"].includes(weak.action), true, `weak preflop should not raise, got ${weak.action}`);

  // A truly monster river hand should be strong (floor >= 90) but the bot must
  // still size bets modestly rather than always shoving.
  const monster = await decide("poker", {
    mode: "bet",
    private: [9, 9, 9],
    shared: [9, 9, 9, 9, 9],
    toCall: 0,
    pot: 1000,
    stack: 10000,
    bigBlind: 100,
    minRaiseTo: 200,
    currentBet: 0,
    opponentsActive: 1,
  }, config);
  assert.ok(monster.strength.floor >= 90, `river monster should be strong, got ${monster.strength.floor}`);
  assert.equal(monster.action, "raise");
  assert.ok(monster.raiseTo <= 3000, `raise must be modest, got ${monster.raiseTo}`);
});

test("Digit Poker validates mode and rules", async () => {
  const config = defaultConfig();
  await assert.rejects(() => decide("poker", { mode: "fold" }, config), /mode must be one of/);
  await assert.rejects(
    () => decide("poker", { mode: "construct", private: [1, 2], shared: [0, 1, 2, 3, 4] }, config),
    /exactly 3 digits/,
  );
  await assert.rejects(
    () => decide("poker", { mode: "construct", private: [1, 4, 8], shared: [0, 2, 3, 5, 9], rules: { bigBlind: 0 } }, config),
    /blinds are invalid/,
  );
});

test("Digit Claim is a registered game with its own knowledge config", () => {
  const config = defaultConfig();
  assert.ok(require("../games").GAME_IDS.includes("claim"));
  assert.ok(config.games.claim);
  assert.ok(config.games.claim.knowledge.VOID.known === true);
});

test("Digit Claim returns a legal claim and placement scored with the official engine", async () => {
  const config = defaultConfig();
  const pool = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7];
  const result = await decide("claim", {
    pool,
    fixed: [null, null, null, null, null, null],
    free: null,
    opponent: { fixed: [null, null, null, null, null, null], free: null },
    order: CLAIM_ORDER,
    index: 0,
  }, config);
  assert.equal(result.game, "claim");
  assert.ok(pool.includes(result.claim));
  assert.equal(result.claimOrder, CLAIM_ORDER);
  assert.equal(result.claimSeconds, 60);
  assert.ok(result.placement);
  assert.equal(typeof result.placement.moveFreeTo === "number" || result.placement.moveFreeTo === null, true);
  assert.equal(typeof result.placement.placeSlot === "number" || result.placement.placeSlot === null, true);
  assert.equal(typeof result.placement.placeFree, "boolean");
  assert.ok(Number.isInteger(result.score) && result.score >= 0);
  assert.ok(Number.isInteger(result.opponentScore) && result.opponentScore >= 0);
  assert.ok(result.projectedNumber >= 0 && result.projectedNumber <= 999999);
  assert.equal(
    result.score,
    scoreNumber(result.projectedNumber, config.games.claim).score,
  );
  assert.equal(result.knowledgeUsed, result.matched.length);
});

test("Digit Claim derives remaining claims from the claim order", async () => {
  const config = defaultConfig();
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4];
  const first = await decide("claim", {
    pool,
    fixed: new Array(6).fill(null),
    free: null,
    order: CLAIM_ORDER,
    index: 0,
  }, config);
  assert.ok(pool.includes(first.claim));
  // The first claim belongs to A, who has all seven A claims left.
  const last = await decide("claim", {
    pool,
    fixed: new Array(6).fill(null),
    free: null,
    order: CLAIM_ORDER,
    index: CLAIM_ORDER.length - 1,
  }, config);
  assert.ok(pool.includes(last.claim));
  // The explicit counts are accepted and equivalent.
  const explicit = await decide("claim", {
    pool,
    fixed: new Array(6).fill(null),
    free: null,
    claimsRemaining: 7,
    opponentClaimsRemaining: 7,
  }, config);
  assert.ok(pool.includes(explicit.claim));
  assert.equal(claimsRemainingFromOrder(CLAIM_ORDER, 0, "A"), 7);
  assert.equal(claimsRemainingFromOrder(CLAIM_ORDER, 0, "B"), 7);
});

test("Digit Claim validates its state and claim bookkeeping", async () => {
  const config = defaultConfig();
  await assert.rejects(
    () => decide("claim", {
      pool: [1, 2, 3],
      fixed: new Array(6).fill(null),
      free: null,
    }, config),
    /claimsRemaining|order with index/,
  );
  await assert.rejects(
    () => decide("claim", {
      pool: [1, 2, 3],
      fixed: new Array(5).fill(null),
      free: null,
      claimsRemaining: 1,
    }, config),
    /exactly 6/,
  );
  await assert.rejects(
    () => decide("claim", {
      pool: [1, 2, 3],
      fixed: new Array(6).fill(null),
      free: 11,
      claimsRemaining: 1,
    }, config),
    /free must be a digit/,
  );
  await assert.rejects(
    () => decide("claim", {
      pool: [1, 2, 30],
      fixed: new Array(6).fill(null),
      free: null,
      claimsRemaining: 1,
    }, config),
    /pool must contain at most 14 digits/,
  );
  await assert.rejects(
    () => decide("claim", {
      pool: [1, 2, 3],
      fixed: new Array(6).fill(null),
      free: null,
      claimsRemaining: 1,
      opponent: { fixed: new Array(6).fill(null), free: 99 },
    }, config),
    /opponent.free/,
  );
});

test("Digit Claim plays a full match with legal moves and a drained pool", async () => {
  const config = defaultConfig();
  const pool = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7];
  const sides = {
    A: { fixed: new Array(6).fill(null), free: null },
    B: { fixed: new Array(6).fill(null), free: null },
  };
  const remaining = pool.slice();
  for (let index = 0; index < CLAIM_ORDER.length; index += 1) {
    const player = CLAIM_ORDER[index] === "A" ? "A" : "B";
    const opponent = player === "A" ? "B" : "A";
    const decision = await decide("claim", {
      pool: remaining,
      fixed: sides[player].fixed,
      free: sides[player].free,
      opponent: { fixed: sides[opponent].fixed, free: sides[opponent].free },
      order: CLAIM_ORDER,
      index,
    }, config);
    assert.ok(remaining.includes(decision.claim), `claim ${decision.claim} must be in the pool`);
    remaining.splice(remaining.indexOf(decision.claim), 1);
    const next = applyClaimPlacement(sides[player], decision.placement, decision.claim);
    sides[player].fixed = next.fixed;
    sides[player].free = next.free;
  }
  assert.equal(remaining.length, 0);
  for (const side of [sides.A, sides.B]) {
    const numberString = side.fixed.join("");
    assert.equal(numberString.length, 6);
    assert.ok(numberString.split("").every((digit) => /[0-9]/.test(digit)));
  }
});

test("decisions reject unknown games and malformed game inputs", async () => {
  await assert.rejects(() => decide("nope", {}, defaultConfig()), /Unknown game/);
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
