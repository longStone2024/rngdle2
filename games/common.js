"use strict";

const { features, scoreKnownBadges } = require("../official-engine");

const GAME_IDS = ["composition", "collection", "target", "climb", "poker", "claim"];

// Time Collection dimensions. The base match is 30 turns / 5 slots; an
// overtime (tiebreaker) is 12 turns. The API supports arbitrary turn and slot
// counts up to the DP ceilings below, so any host can run a custom-length
// match (e.g. a 12-turn overtime) without regenerating the engine.
const DEFAULT_TURNS = 30;
const DEFAULT_SLOTS = 5;
const COLLECTION_OVERTIME_TURNS = 12;
const MAX_TURNS = 200;
const MAX_SLOTS = 10;

// Digit Poker table rules. Every gameplay value mentioned in the spec is
// configurable here so hosts and API clients can override them.
const POKER_RULES = {
  minPlayers: 2,
  maxPlayers: 6,
  startingChips: 10000,
  minRounds: 1,
  maxRounds: 10,
  smallBlind: 50,
  bigBlind: 100,
  fishFeeBb: 2.5,
  firstHandFish: 2,
  fishPerHand: 1,
  privateDigits: 3,
  sharedDigits: 5,
  slots: 6,
  privateSlots: [2, 5], // 1-indexed, matching the spec "slots 2 and 5 must be private"
  digitCopies: 8,
  betTurnSeconds: 15,
  constructSeconds: 30,
  rebuys: false,
  carryFishOnSplit: true,
  // Betting-strength anchors: percentile -> EP for achievable poker hands.
  // Hosts may override to tune bot aggression; omitted values use the default.
  strengthAnchors: null,
};

class DecisionInputError extends Error {}

function defaultConfig() {
  return {
    games: Object.fromEntries(GAME_IDS.map((game) => [
      game,
      {
        knowledge: Object.fromEntries(features.map(({ id }) => [id, { known: true }])),
      },
    ])),
  };
}

function normalizeConfig(input) {
  const defaults = defaultConfig();
  if (!input || typeof input !== "object") return defaults;

  for (const game of GAME_IDS) {
    const source = input.games?.[game];
    if (!source || typeof source !== "object") continue;
    for (const { id } of features) {
      if (source.knowledge?.[id]?.known === false) {
        defaults.games[game].knowledge[id] = { known: false };
      }
    }
  }
  return defaults;
}

function knownBadges(gameConfig) {
  return new Set(features
    .filter(({ id }) => gameConfig.knowledge[id]?.known !== false)
    .map(({ id }) => id));
}

function scoreNumber(value, gameConfig) {
  return scoreBadgeSet(value, knownBadges(gameConfig));
}

function scoreBadgeSet(value, known) {
  return scoreKnownBadges(value, known);
}

function validateDigits(digits, count, label) {
  if (!Array.isArray(digits) || digits.length !== count
      || digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new DecisionInputError(`${label} must contain exactly ${count} digits between 0 and 9`);
  }
}

// Merge caller-supplied overrides onto the default Poker table rules. Allowed
// numeric fields are coerced to finite, safe integers so a host can pass any
// JSON-encoded value; invalid or out-of-range values throw instead of being
// silently ignored.
function normalizePokerRules(overrides) {
  const rules = { ...POKER_RULES };
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return rules;

  const integerFields = [
    "minPlayers", "maxPlayers", "startingChips", "minRounds", "maxRounds",
    "smallBlind", "bigBlind", "firstHandFish", "fishPerHand", "privateDigits",
    "sharedDigits", "slots", "digitCopies", "betTurnSeconds", "constructSeconds",
  ];
  for (const field of integerFields) {
    if (overrides[field] === undefined) continue;
    const value = Number(overrides[field]);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new DecisionInputError(`poker rule "${field}" must be an integer`);
    }
    rules[field] = value;
  }
  if (overrides.fishFeeBb !== undefined) {
    const value = Number(overrides.fishFeeBb);
    if (!Number.isFinite(value) || value < 0) {
      throw new DecisionInputError("poker rule \"fishFeeBb\" must be a non-negative number");
    }
    rules.fishFeeBb = value;
  }
  if (overrides.privateSlots !== undefined) {
    if (!Array.isArray(overrides.privateSlots)
        || overrides.privateSlots.some((slot) => !Number.isInteger(Number(slot)))) {
      throw new DecisionInputError("poker rule \"privateSlots\" must be an array of integers");
    }
    rules.privateSlots = overrides.privateSlots.map((slot) => Number(slot));
  }
  for (const field of ["rebuys", "carryFishOnSplit"]) {
    if (overrides[field] !== undefined) rules[field] = overrides[field] === true;
  }
  return rules;
}

module.exports = {
  COLLECTION_OVERTIME_TURNS,
  DEFAULT_SLOTS,
  DEFAULT_TURNS,
  MAX_SLOTS,
  MAX_TURNS,
  DecisionInputError,
  GAME_IDS,
  POKER_RULES,
  defaultConfig,
  knownBadges,
  normalizeConfig,
  normalizePokerRules,
  scoreBadgeSet,
  scoreNumber,
  validateDigits,
};
