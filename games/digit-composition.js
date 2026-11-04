"use strict";

const { knownBadges, scoreBadgeSet, validateDigits, DecisionInputError } = require("./common");

function decide(input, gameConfig) {
  validateDigits(input.key, 3, "key");
  validateDigits(input.open, 5, "open");
  const key = input.key.map((digit, index) => ({ digit, tag: `k${index}` }));
  const open = input.open.map((digit, index) => ({ digit, tag: `o${index}` }));
  const known = knownBadges(gameConfig);
  let best = null;

  for (let firstKey = 0; firstKey < 3; firstKey++) {
    for (let secondKey = 0; secondKey < 3; secondKey++) {
      if (firstKey === secondKey) continue;
      const available = [
        ...key.filter((_, index) => index !== firstKey && index !== secondKey),
        ...open,
      ];
      const positions = [null, key[firstKey], null, null, key[secondKey], null];
      const used = new Set([key[firstKey].tag, key[secondKey].tag]);

      function visit(position) {
        if (position === 6) {
          const number = Number(positions.map((item) => item.digit).join(""));
          const scoring = scoreBadgeSet(number, known);
          const candidate = {
            number,
            score: scoring.score,
            matched: scoring.matched,
            scoringBadges: scoring.scoringBadges,
            arrangement: positions.map((item) => item.tag),
          };
          if (!best || candidate.score > best.score
              || (candidate.score === best.score && candidate.number > best.number)) {
            best = candidate;
          }
          return;
        }
        if (position === 1 || position === 4) {
          visit(position + 1);
          return;
        }
        for (const item of available) {
          if (used.has(item.tag)) continue;
          used.add(item.tag);
          positions[position] = item;
          visit(position + 1);
          positions[position] = null;
          used.delete(item.tag);
        }
      }

      visit(0);
    }
  }

  if (!best) throw new DecisionInputError("No valid six-digit arrangement can be made from these digits");
  return {
    game: "composition",
    ...best,
    knowledgeUsed: best.matched.length,
  };
}

module.exports = { decide };
