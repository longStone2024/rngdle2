"use strict";

const common = require("./common");
const composition = require("./digit-composition");
const collection = require("./time-collection");
const target = require("./target-chase");

async function decide(game, input, config) {
  const normalized = common.normalizeConfig(config);
  switch (game) {
    case "composition":
      return composition.decide(input, normalized.games.composition);
    case "collection":
      return collection.decide(input, normalized.games.collection);
    case "target":
      return target.decide(input, normalized.games.target);
    default:
      throw new common.DecisionInputError("Unknown game");
  }
}

function prewarmCollection(config) {
  const normalized = common.normalizeConfig(config);
  return collection.warmThresholds(common.knownBadges(normalized.games.collection));
}

module.exports = {
  ...common,
  FEATURES: require("../official-engine").features,
  computeOptimalThresholds: collection.computeOptimalThresholds,
  decide,
  prewarmCollection,
};
