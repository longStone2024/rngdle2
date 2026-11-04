"use strict";

const { categoryForBadge } = require("./feature-categories");
const { translateDescription } = require("./feature-locales");

const SCORE_MODULE_ID = 510584;
const BADGE_MODULE_ID = 167711;
const ENGINE_MODULE_ID = 710163;

function loadCalculatorModules() {
  if (!globalThis.TURBOPACK) globalThis.TURBOPACK = [];
  const firstChunk = globalThis.TURBOPACK.length;
  require("./calculator.js");
  const chunks = globalThis.TURBOPACK.slice(firstChunk);
  const modules = new Map();

  for (const chunk of chunks) {
    for (let index = 1; index < chunk.length;) {
      const moduleId = chunk[index++];
      let exportId = null;
      let factory;
      if (typeof chunk[index] === "number") {
        exportId = chunk[index++];
        factory = chunk[index++];
      } else {
        factory = chunk[index++];
      }
      if (typeof moduleId !== "number" || typeof factory !== "function") continue;

      const exports = Object.create(null);
      modules.set(moduleId, exports);
      if (exportId !== null) modules.set(exportId, exports);
      const runtime = {
        i(dependencyId) {
          const dependency = modules.get(dependencyId);
          if (!dependency) throw new Error(`Calculator module ${dependencyId} is unavailable`);
          return dependency;
        },
        s(specification, targetId) {
          const target = targetId === undefined
            ? exports
            : modules.get(targetId) || Object.create(null);
          if (targetId !== undefined) modules.set(targetId, target);
          for (let cursor = 0; cursor < specification.length;) {
            const name = specification[cursor++];
            const value = specification[cursor++];
            if (value === 0) {
              target[name] = specification[cursor++];
            } else {
              Object.defineProperty(target, name, {
                configurable: false,
                enumerable: true,
                get: value,
              });
            }
          }
        },
      };
      factory(runtime);
    }
  }

  const engine = modules.get(ENGINE_MODULE_ID);
  const badgeDefinitions = modules.get(BADGE_MODULE_ID)?.BADGE_DEFINITIONS;
  const scoredBadges = modules.get(SCORE_MODULE_ID)?.SCORED_BADGES;
  if (!engine?.analyzeNumber || !engine?.getPercentileForScore || !badgeDefinitions || !scoredBadges) {
    throw new Error("The bundled calculator does not expose the expected scoring engine");
  }

  return { engine, badgeDefinitions, scoredBadges };
}

const { engine, badgeDefinitions, scoredBadges } = loadCalculatorModules();
const definitionsById = new Map(badgeDefinitions.map((definition) => [definition.id, definition]));
const scoredBadgesById = new Map();
const scoredEntries = [];
const features = scoredBadges.map((badge) => {
  const definition = definitionsById.get(badge.id);
  if (!definition || typeof definition.check !== "function") {
    throw new Error(`Calculator definition is missing for scored badge ${badge.id}`);
  }
  const feature = {
    id: badge.id,
    name: badge.label,
    description: badge.description,
    descriptionZh: translateDescription(badge.description),
    emoji: badge.emoji,
    score: badge.score,
    probability: badge.probability,
    family: definition.family || null,
    category: categoryForBadge(badge.id),
  };
  scoredBadgesById.set(feature.id, feature);
  scoredEntries.push({ definition, badge: feature });
  return feature;
});

function analyzeNumber(number) {
  return engine.analyzeNumber(number);
}

function percentileForScore(score) {
  return engine.getPercentileForScore(score);
}

function scoreKnownBadges(number, knownBadgeIds) {
  const known = knownBadgeIds instanceof Set ? knownBadgeIds : new Set(knownBadgeIds);
  const familyWinners = new Map();
  const matched = [];
  const scoringBadges = [];
  let score = 0;
  const value = Number(number);
  const valueString = String(value);

  for (const definition of badgeDefinitions) {
    const badge = scoredBadgesById.get(definition.id);
    if (!badge || !known.has(badge.id) || !definition.check(value, valueString)) continue;
    matched.push(badge.id);
    if (badge.family) {
      const winner = familyWinners.get(badge.family);
      if (!winner || badge.score > winner.score) familyWinners.set(badge.family, badge);
    } else {
      scoringBadges.push(badge.id);
      score += badge.score;
    }
  }

  for (const badge of familyWinners.values()) {
    scoringBadges.push(badge.id);
    score += badge.score;
  }

  return {
    score,
    matched,
    scoringBadges,
  };
}

function compileEntryScorer(entries) {
  if (entries.length === 0) return () => 0;
  const independent = [];
  const families = new Map();
  for (const entry of entries) {
    if (!entry.badge.family) {
      independent.push(entry);
      continue;
    }
    if (!families.has(entry.badge.family)) families.set(entry.badge.family, []);
    families.get(entry.badge.family).push(entry);
  }
  const familyEntries = [...families.values()];

  return (number) => {
    const value = Number(number);
    const valueString = String(value);
    let score = 0;
    for (const { definition, badge } of independent) {
      if (definition.check(value, valueString)) score += badge.score;
    }
    for (const entriesInFamily of familyEntries) {
      let highestScore = 0;
      for (const { definition, badge } of entriesInFamily) {
        if (badge.score > highestScore && definition.check(value, valueString)) {
          highestScore = badge.score;
        }
      }
      score += highestScore;
    }
    return score;
  };
}

function createKnownBadgeScorer(knownBadgeIds) {
  const known = knownBadgeIds instanceof Set ? knownBadgeIds : new Set(knownBadgeIds);
  const knownEntries = scoredEntries.filter(({ badge }) => known.has(badge.id));
  return compileEntryScorer(knownEntries);
}

module.exports = {
  features,
  analyzeNumber,
  percentileForScore,
  scoreKnownBadges,
  createKnownBadgeScorer,
  scoredBadgesById,
};
