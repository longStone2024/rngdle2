"use strict";

const { features, scoreKnownBadges } = require("../official-engine");

const GAME_IDS = ["composition", "collection", "target", "climb"];
const DEFAULT_TURNS = 30;
const DEFAULT_SLOTS = 5;

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

module.exports = {
  DEFAULT_SLOTS,
  DEFAULT_TURNS,
  DecisionInputError,
  GAME_IDS,
  defaultConfig,
  knownBadges,
  normalizeConfig,
  scoreBadgeSet,
  scoreNumber,
  validateDigits,
};
