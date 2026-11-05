"use strict";

const {
  UNCOMMON_SCORE_THRESHOLD,
  createKnownBadgeScorer,
  isUncommonNumber,
} = require("../official-engine");
const {
  DEFAULT_SLOTS,
  DEFAULT_TURNS,
  DecisionInputError,
  knownBadges,
  scoreNumber,
} = require("./common");

const MAX_NUMBER = 1_000_000;
const DISTRIBUTION_SIZE = MAX_NUMBER + 1;
const MAX_CACHED_DISTRIBUTIONS = 4;
const distributionCache = new Map();
let eligibleNumbersPromise;

function lowerBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function makePrefixSums(sorted) {
  const prefix = new Float64Array(sorted.length + 1);
  for (let index = 0; index < sorted.length; index++) {
    prefix[index + 1] = prefix[index] + sorted[index];
  }
  return prefix;
}

function computeThresholds(sorted, prefix, turns, slots) {
  const value = Array.from({ length: turns + 1 }, () => new Float64Array(slots + 1));
  const threshold = Array.from({ length: turns + 1 }, () => new Float64Array(slots + 1));
  const sampleCount = sorted.length;
  const total = prefix[prefix.length - 1];
  const mean = total / sampleCount;

  for (let remaining = 1; remaining <= turns; remaining++) {
    for (let slotsLeft = 1; slotsLeft <= Math.min(slots, remaining); slotsLeft++) {
      if (slotsLeft === remaining) {
        value[remaining][slotsLeft] = mean + value[remaining - 1][slotsLeft - 1];
        threshold[remaining][slotsLeft] = Number.NEGATIVE_INFINITY;
        continue;
      }
      const skipValue = value[remaining - 1][slotsLeft];
      const takeContinuation = value[remaining - 1][slotsLeft - 1];
      const cutoff = skipValue - takeContinuation;
      const firstAccepted = lowerBound(sorted, cutoff);
      const acceptedSum = total - prefix[firstAccepted];
      const acceptedExtra = acceptedSum - cutoff * (sampleCount - firstAccepted);
      value[remaining][slotsLeft] = skipValue + acceptedExtra / sampleCount;
      threshold[remaining][slotsLeft] = cutoff;
    }
  }
  return threshold;
}

function distributionKey(known) {
  return [...known].sort().join(",");
}

async function buildThresholds(known) {
  const eligibleNumbers = await getEligibleNumbers();
  const scores = new Uint32Array(eligibleNumbers.length);
  const scoreKnown = createKnownBadgeScorer(known);
  const batchSize = 512;
  for (let start = 0; start < eligibleNumbers.length; start += batchSize) {
    const end = Math.min(start + batchSize, eligibleNumbers.length);
    for (let index = start; index < end; index++) {
      scores[index] = scoreKnown(eligibleNumbers[index]);
    }
    if (end < eligibleNumbers.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  scores.sort();
  const prefix = makePrefixSums(scores);
  return computeThresholds(scores, prefix, DEFAULT_TURNS, DEFAULT_SLOTS);
}

async function buildEligibleNumbers() {
  const eligibleNumbers = [];
  const batchSize = 512;
  for (let start = 0; start < DISTRIBUTION_SIZE; start += batchSize) {
    const end = Math.min(start + batchSize, DISTRIBUTION_SIZE);
    for (let number = start; number < end; number++) {
      if (isUncommonNumber(number)) eligibleNumbers.push(number);
    }
    if (end < DISTRIBUTION_SIZE) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (eligibleNumbers.length === 0) throw new Error("No Uncommon-or-higher Time Collection numbers are available");
  return eligibleNumbers;
}

function getEligibleNumbers() {
  if (!eligibleNumbersPromise) {
    eligibleNumbersPromise = buildEligibleNumbers().catch((error) => {
      eligibleNumbersPromise = null;
      throw error;
    });
  }
  return eligibleNumbersPromise;
}

function getThresholds(known) {
  const key = distributionKey(known);
  if (distributionCache.has(key)) {
    const cached = distributionCache.get(key);
    distributionCache.delete(key);
    distributionCache.set(key, cached);
    return cached;
  }

  const pending = buildThresholds(known);
  distributionCache.set(key, pending);
  pending.catch(() => {
    if (distributionCache.get(key) === pending) distributionCache.delete(key);
  });
  while (distributionCache.size > MAX_CACHED_DISTRIBUTIONS) {
    distributionCache.delete(distributionCache.keys().next().value);
  }
  return pending;
}

function warmThresholds(known) {
  return getThresholds(known);
}

async function decide(input, gameConfig) {
  const { current, remainingTurns, slotsRemaining } = input;
  if (!Number.isInteger(current) || current < 0 || current > MAX_NUMBER) {
    throw new DecisionInputError(`current must be an integer between 0 and ${MAX_NUMBER}`);
  }
  if (!isUncommonNumber(current)) {
    throw new DecisionInputError(
      `current must be Uncommon or higher (official score percentile at least 50%; score threshold ${UNCOMMON_SCORE_THRESHOLD})`,
    );
  }
  if (!Number.isInteger(remainingTurns) || remainingTurns < 1 || remainingTurns > DEFAULT_TURNS) {
    throw new DecisionInputError(`remainingTurns must be an integer between 1 and ${DEFAULT_TURNS}`);
  }
  if (!Number.isInteger(slotsRemaining) || slotsRemaining < 0
      || slotsRemaining > Math.min(DEFAULT_SLOTS, remainingTurns)) {
    throw new DecisionInputError(
      `slotsRemaining must be an integer between 0 and ${Math.min(DEFAULT_SLOTS, remainingTurns)}`,
    );
  }

  const scoring = scoreNumber(current, gameConfig);
  let take = false;
  let threshold = Number.POSITIVE_INFINITY;
  if (slotsRemaining > 0) {
    if (slotsRemaining >= remainingTurns) {
      take = true;
      threshold = Number.NEGATIVE_INFINITY;
    } else {
      const thresholds = await getThresholds(knownBadges(gameConfig));
      threshold = thresholds[remainingTurns][slotsRemaining];
      take = scoring.score >= threshold;
    }
  }

  return {
    game: "collection",
    action: take ? "take" : "skip",
    current,
    score: scoring.score,
    threshold: Number.isFinite(threshold) ? Number(threshold.toFixed(2)) : null,
    forced: slotsRemaining > 0 && slotsRemaining >= remainingTurns,
    matched: scoring.matched,
    scoringBadges: scoring.scoringBadges,
    knowledgeUsed: scoring.matched.length,
  };
}

module.exports = {
  computeOptimalThresholds: (scores, turns, slots) => {
    if (!Array.isArray(scores) || !scores.length) {
      throw new DecisionInputError("A non-empty score distribution is required");
    }
    if (!Number.isInteger(turns) || turns < 1
        || !Number.isInteger(slots) || slots < 0 || slots > turns) {
      throw new DecisionInputError("Expected 1 <= turns and 0 <= slots <= turns");
    }
    const sorted = [...scores].sort((a, b) => a - b);
    return computeThresholds(sorted, makePrefixSums(sorted), turns, slots);
  },
  warmThresholds,
  decide,
};
