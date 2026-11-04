"use strict";

const { knownBadges, scoreBadgeSet, DecisionInputError } = require("./common");

const MAX_TARGET_NUMBER = 1_000_000;
const MAX_TARGET_SCORE = 0xFFFF_FFFF;

function decide(input, gameConfig) {
  const number = input.number;
  const target = input.target;
  if (!Number.isInteger(number) || number < 0 || number > MAX_TARGET_NUMBER) {
    throw new DecisionInputError(`number must be an integer between 0 and ${MAX_TARGET_NUMBER}`);
  }
  if (!Number.isSafeInteger(target) || target < 0 || target > MAX_TARGET_SCORE) {
    throw new DecisionInputError(`target must be an integer between 0 and ${MAX_TARGET_SCORE}`);
  }

  const digits = String(number).split("");
  const known = knownBadges(gameConfig);
  let best = null;
  for (let position = 0; position < digits.length; position++) {
    for (let digit = 0; digit <= 9; digit++) {
      if (String(digit) === digits[position] || (position === 0 && digit === 0)) continue;
      const changed = [...digits];
      changed[position] = String(digit);
      const result = Number(changed.join(""));
      if (result > MAX_TARGET_NUMBER) continue;
      const scoring = scoreBadgeSet(result, known);
      const distance = Math.abs(scoring.score - target);
      if (!best || distance < best.distance
          || (distance === best.distance && result < best.result)) {
        best = {
          result,
          distance,
          position,
          replacement: digit,
          score: scoring.score,
          matched: scoring.matched,
          scoringBadges: scoring.scoringBadges,
        };
      }
    }
  }

  if (!best) throw new DecisionInputError("No legal one-digit change can be made");
  return {
    game: "target",
    number,
    target,
    ...best,
    knowledgeUsed: best.matched.length,
  };
}

module.exports = { decide };
