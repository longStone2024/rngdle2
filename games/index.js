"use strict";

const common = require("./common");
const composition = require("./digit-composition");
const collection = require("./time-collection");
const target = require("./target-chase");
const climb = require("./digit-climb");

async function decide(game, input, config) {
  const normalized = common.normalizeConfig(config);
  switch (game) {
    case "composition":
      return composition.decide(input, normalized.games.composition);
    case "collection":
      return collection.decide(input, normalized.games.collection);
    case "target":
      return target.decide(input, normalized.games.target);
    case "climb":
      return climb.decide(input, normalized.games.climb);
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
  isUncommonNumber: require("../official-engine").isUncommonNumber,
  percentileForNumber: require("../official-engine").percentileForNumber,
  computeOptimalThresholds: collection.computeOptimalThresholds,
  decide,
  decideDigitClimb: climb.decide,
  prewarmCollection,
};
