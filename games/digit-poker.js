"use strict";

const {
  scoreKnownBadges,
} = require("../official-engine");
const {
  DecisionInputError,
  knownBadges,
  normalizePokerRules,
} = require("./common");

const VALID_MODES = ["construct", "bet"];

// Hand-strength anchors: the EP (badge score) distribution of the *best
// achievable six-digit hand* over a large random sample of full poker hands
// (3 private + 5 shared, all 233 badges known). Ranks here are true hand
// strength — unlike `percentileForScore`, which ranks against every integer
// 0..1,000,000 and is saturated (almost every optimized hand is "99%+").
// Each entry is [strengthPercentile, epScore]; values between anchors are
// interpolated in log space. Overridable via rules.strengthAnchors.
const STRENGTH_ANCHORS = [
  [0, 7_315],
  [5, 65_874],
  [10, 106_742],
  [20, 164_594],
  [30, 214_718],
  [40, 282_956],
  [50, 344_421],
  [60, 431_019],
  [70, 565_468],
  [80, 1_006_387],
  [85, 1_710_875],
  [90, 3_573_747],
  [93, 5_077_153],
  [95, 12_506_538],
  [97, 25_017_717],
  [99, 50_037_391],
  [100, 186_186_584],
];

// Map an EP score to a 0..100 hand-strength percentile using the anchors.
function scoreToStrength(score, anchors) {
  if (!(score >= 0)) return 0;
  const points = anchors || STRENGTH_ANCHORS;
  if (score <= points[0][1]) return points[0][0];
  if (score >= points[points.length - 1][1]) return points[points.length - 1][0];
  const logScore = Math.log(score);
  for (let i = 1; i < points.length; i++) {
    const [hi, hiScore] = points[i];
    const [lo, loScore] = points[i - 1];
    if (score <= hiScore) {
      const loLog = Math.log(Math.max(1, loScore));
      const hiLog = Math.log(hiScore);
      const t = (logScore - loLog) / (hiLog - loLog);
      return lo + (hi - lo) * t;
    }
  }
  return points[points.length - 1][0];
}

function validateDigits(digits, count, label) {
  if (!Array.isArray(digits)
      || digits.length !== count
      || digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new DecisionInputError(`${label} must contain exactly ${count} digits between 0 and 9`);
  }
}

function validateRevealedShared(digits, max, label) {
  if (!Array.isArray(digits)
      || digits.length > max
      || digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    throw new DecisionInputError(`${label} must contain at most ${max} digits between 0 and 9`);
  }
}

function validateRules(rules) {
  const normalized = normalizePokerRules(rules);
  if (normalized.minPlayers < 2 || normalized.minPlayers > 20) {
    throw new DecisionInputError("poker rule \"minPlayers\" must be between 2 and 20");
  }
  if (normalized.maxPlayers < normalized.minPlayers) {
    throw new DecisionInputError("poker rule \"maxPlayers\" must be at least minPlayers");
  }
  if (normalized.startingChips < 1) {
    throw new DecisionInputError("poker rule \"startingChips\" must be positive");
  }
  if (normalized.minRounds < 1 || normalized.maxRounds < normalized.minRounds) {
    throw new DecisionInputError("poker round limits are invalid");
  }
  if (normalized.smallBlind < 1 || normalized.bigBlind < normalized.smallBlind) {
    throw new DecisionInputError("poker blinds are invalid");
  }
  if (normalized.fishFeeBb < 0) {
    throw new DecisionInputError("poker rule \"fishFeeBb\" must be non-negative");
  }
  if (normalized.firstHandFish < 0 || normalized.fishPerHand < 0) {
    throw new DecisionInputError("poker fish counts must be non-negative");
  }
  if (normalized.privateDigits < 1 || normalized.sharedDigits < 0
      || normalized.slots < 2 || normalized.privateDigits + normalized.sharedDigits < normalized.slots) {
    throw new DecisionInputError("poker digit counts are invalid");
  }
  if (!Array.isArray(normalized.privateSlots)
      || normalized.privateSlots.length !== 2
      || new Set(normalized.privateSlots.map(Number)).size !== 2
      || normalized.privateSlots.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > normalized.slots)) {
    throw new DecisionInputError("poker rule \"privateSlots\" must list exactly two distinct slot positions within the slot count");
  }
  if (normalized.digitCopies < 1 || normalized.betTurnSeconds < 1 || normalized.constructSeconds < 1) {
    throw new DecisionInputError("poker timing and digit-copy rules must be positive");
  }
  return normalized;
}

// Enumerate every legal six-slot arrangement and return the arrangement with
// the highest badge EP (the game decides by EP, not by integer size). The two
// private slots each receive a private digit; the remaining slots are filled
// from the leftover private digit plus the shared digits, every token at most
// once. `fixed` optionally locks some slots (timeout completion) and `lowest`
// asks for the lowest-EP legal completion instead of the highest.
function solveConstruction(privateDigits, sharedDigits, rules, known, fixed, lowest) {
  const slots = rules.slots;
  const privateSlots = rules.privateSlots.map((slot) => Number(slot) - 1);
  const openSlots = [];
  for (let index = 0; index < slots; index++) {
    if (!privateSlots.includes(index)) openSlots.push(index);
  }

  const privateTokens = privateDigits.map((digit, index) => ({ digit, tag: `p${index}` }));
  const sharedTokens = sharedDigits.map((digit, index) => ({ digit, tag: `s${index}` }));

  const fixedMap = new Map();
  if (Array.isArray(fixed)) {
    for (let index = 0; index < slots && index < fixed.length; index++) {
      const value = fixed[index];
      if (value === null || value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > 9) {
        throw new DecisionInputError("fixed slot values must be digits between 0 and 9");
      }
      fixedMap.set(index, value);
    }
  }

  let best = null;
  const consider = (positions) => {
    const digitsString = positions.map((item) => String(item.digit)).join("");
    const number = Number(digitsString);
    const scoring = scoreKnownBadges(number, known);
    const candidate = {
      number,
      digits: digitsString,
      score: scoring.score,
      matched: scoring.matched,
      scoringBadges: scoring.scoringBadges,
      arrangement: positions.map((item) => item.tag),
    };
    if (!best) {
      best = candidate;
      return;
    }
    const better = lowest
      ? candidate.score < best.score
      : candidate.score > best.score;
    if (better) best = candidate;
  };

  function validateFixed(positions) {
    for (const [slot, digit] of fixedMap) {
      if (positions[slot].digit !== digit) return false;
    }
    return true;
  }

  // Place two distinct private tokens into the two private slots.
  for (let first = 0; first < privateTokens.length; first++) {
    for (let second = 0; second < privateTokens.length; second++) {
      if (first === second) continue;
      const positions = new Array(slots).fill(null);
      positions[privateSlots[0]] = privateTokens[first];
      positions[privateSlots[1]] = privateTokens[second];
      const used = new Set([privateTokens[first].tag, privateTokens[second].tag]);
      const remaining = [
        ...privateTokens.filter((token) => !used.has(token.tag)),
        ...sharedTokens,
      ];
      // Permute the open slots from the remaining tokens.
      const fill = (openIndex) => {
        if (openIndex === openSlots.length) {
          if (validateFixed(positions)) consider(positions);
          return;
        }
        const slot = openSlots[openIndex];
        for (const token of remaining) {
          if (used.has(token.tag)) continue;
          used.add(token.tag);
          positions[slot] = token;
          fill(openIndex + 1);
          positions[slot] = null;
          used.delete(token.tag);
        }
      };
      fill(0);
    }
  }

  return best;
}

function constructDecision(input, rules, known) {
  validateDigits(input.private, rules.privateDigits, "private");
  validateDigits(input.shared, rules.sharedDigits, "shared");
  if (rules.privateSlots.length !== 2) {
    throw new DecisionInputError("construction requires exactly two private slots");
  }
  if (input.fixed !== undefined && !Array.isArray(input.fixed)) {
    throw new DecisionInputError("fixed must be an array of digits or null values");
  }
  const best = solveConstruction(input.private, input.shared, rules, known, input.fixed, false);
  if (!best) throw new DecisionInputError("No legal arrangement can be made from these digits");

  const decision = {
    game: "poker",
    mode: "construct",
    best,
    knowledgeUsed: best.matched.length,
  };

  // Lowest-EP legal completion (used for timeout autofill, or when the caller
  // explicitly wants the worst case for analysis).
  if (input.fixed !== undefined || input.lowest === true) {
    const completion = solveConstruction(input.private, input.shared, rules, known, input.fixed, true);
    decision.completion = completion || best;
  }
  return decision;
}

// Strength estimate for betting. The player's showdown strength in this game is
// the highest EP achievable from the private digits + the shared digits revealed
// so far, ranked against the distribution of achievable poker hands (not against
// every integer, which is saturated). Because unrevealed shared digits are still
// unknown, we compute two bounds — filling the missing shared digits with 0 and
// with 9 — and take their midpoint on the 0..100 hand-strength scale.
function strengthFromKnown(privateDigits, revealedShared, rules, known) {
  const anchors = normalizeAnchors(rules.strengthAnchors);
  const floorShared = revealedShared.slice();
  while (floorShared.length < rules.sharedDigits) floorShared.push(0);
  const ceilShared = revealedShared.slice();
  while (ceilShared.length < rules.sharedDigits) ceilShared.push(9);

  const floorBest = solveConstruction(privateDigits, floorShared, rules, known, null, false);
  const ceilBest = solveConstruction(privateDigits, ceilShared, rules, known, null, false);
  if (!floorBest || !ceilBest) {
    return { score: 0, percentile: 0, floor: 0, ceiling: 0, mid: 0, revealed: 0, best: null };
  }

  const floor = scoreToStrength(floorBest.score, anchors);
  const ceiling = scoreToStrength(ceilBest.score, anchors);
  // A shared digit of 0 can score higher than 9 (e.g. VOID), so the two bounds
  // may invert; order them so `floor` is the weaker and `ceiling` the stronger.
  const lo = Math.min(floor, ceiling);
  const hi = Math.max(floor, ceiling);
  const mid = (lo + hi) / 2;

  return {
    score: floorBest.score,
    percentile: mid,
    floor: lo,
    ceiling: hi,
    mid,
    revealed: revealedShared.length,
    best: floorBest,
  };
}

function normalizeAnchors(input) {
  if (Array.isArray(input)
      && input.length >= 2
      && input.every((point) => Array.isArray(point) && point.length === 2
        && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))) {
    const points = input
      .map(([pct, ep]) => [Number(pct), Number(ep)])
      .sort((a, b) => a[1] - b[1]);
    if (points.every(([pct]) => pct >= 0 && pct <= 100)) return points;
  }
  return STRENGTH_ANCHORS;
}

function betDecision(input, rules, known) {
  validateDigits(input.private, rules.privateDigits, "private");
  validateRevealedShared(input.shared, rules.sharedDigits, "shared");
  const strength = strengthFromKnown(input.private, input.shared, rules, known);

  const toCall = Number.isFinite(Number(input.toCall)) ? Math.max(0, Math.floor(Number(input.toCall))) : 0;
  const pot = Number.isFinite(Number(input.pot)) ? Math.max(0, Math.floor(Number(input.pot))) : 0;
  const stack = Number.isFinite(Number(input.stack)) ? Math.max(0, Math.floor(Number(input.stack))) : 0;
  const bigBlind = Number.isFinite(Number(input.bigBlind)) && Number(input.bigBlind) > 0
    ? Number(input.bigBlind)
    : rules.bigBlind;
  const minRaiseTo = Number.isFinite(Number(input.minRaiseTo))
    ? Math.max(0, Math.floor(Number(input.minRaiseTo)))
    : 0;
  const opponentsActive = Number.isSafeInteger(input.opponentsActive) && input.opponentsActive >= 0
    ? input.opponentsActive
    : 0;
  const currentBet = Number.isFinite(Number(input.currentBet))
    ? Math.max(0, Math.floor(Number(input.currentBet)))
    : toCall;

  const bb = bigBlind;
  const street = strength.revealed; // 0 preflop, 3 flop, 4 turn, 5 river
  const floor = strength.floor;
  const ceiling = strength.ceiling;
  const mid = strength.mid;

  // Pot odds: the equity we would need to justify a call.
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  // `nuts` means "even the pessimistic completion is elite" — only then do we
  // want to commit the whole stack. Requiring the floor (not just the midpoint)
  // to be extreme stops bots from shoving with draws. On the hand-strength
  // scale, 97+ is genuinely rare (top ~3% of hands).
  const nuts = street >= 5 && floor >= 97;
  const shortStack = stack <= 2 * bb;

  // A raise is expressed as an absolute "raise TO" level (the front-end clamps
  // it to minRaiseTo). `extra` is the chips added on top of the current bet.
  const raiseTarget = (extra) => Math.max(minRaiseTo, currentBet + extra);

  let action;
  let raiseTo = null;

  if (shortStack && toCall > 0) {
    // Very short stack: push or fold, nothing in between.
    if (mid >= 70) {
      action = "allin";
      raiseTo = toCall + stack;
    } else {
      action = "fold";
    }
  } else if (toCall === 0) {
    // Free to check. Bet only when the hand is genuinely strong, and size the
    // bet modestly (a fraction of the pot) so a single bet never busts us.
    if (nuts && opponentsActive <= 1) {
      action = "raise";
      raiseTo = raiseTarget(Math.max(bb, Math.floor(pot * 0.75)));
    } else if (floor >= 75 && street >= 4) {
      action = "raise";
      raiseTo = raiseTarget(Math.max(bb, Math.floor(pot * 0.5)));
    } else if (ceiling >= 90 && street <= 3) {
      action = "raise";
      raiseTo = raiseTarget(Math.max(bb, Math.floor(pot * 0.33)));
    } else {
      action = "check";
    }
  } else {
    // Facing a bet. Fold when we are (pessimistically) weak or the pot odds do
    // not justify continuing; only raise when confident.
    if (nuts && opponentsActive <= 1) {
      action = "allin";
      raiseTo = toCall + stack;
    } else if (floor < 40) {
      action = "fold";
    } else if (mid / 100 < potOdds - 0.05) {
      action = "fold";
    } else if (floor >= 85 && street >= 4) {
      action = "raise";
      raiseTo = raiseTarget(Math.max(bb, Math.floor(pot * 0.6)));
    } else if (ceiling >= 90 && street >= 3 && potOdds < 0.25) {
      action = "raise";
      raiseTo = raiseTarget(Math.max(bb, Math.floor(pot * 0.4)));
    } else {
      action = "call";
    }
  }

  // Stack protection: a single (non-all-in) bet never commits more than 30% of
  // the remaining stack. This is the main guard against chip dumping.
  if (action === "raise" && raiseTo !== null) {
    const cap = currentBet + Math.floor(stack * 0.3);
    if (raiseTo > cap && cap >= minRaiseTo) raiseTo = cap;
  }

  return {
    game: "poker",
    mode: "bet",
    action,
    raiseTo,
    strength: {
      score: strength.score,
      percentile: strength.percentile,
      floor: strength.floor,
      ceiling: strength.ceiling,
      mid: strength.mid,
      revealed: strength.revealed,
      best: strength.best,
    },
    potOdds,
    knowledgeUsed: strength.best ? strength.best.matched.length : 0,
  };
}

function decide(input, gameConfig) {
  const mode = input.mode;
  if (!VALID_MODES.includes(mode)) {
    throw new DecisionInputError(`poker mode must be one of ${VALID_MODES.join(", ")}`);
  }
  const rules = validateRules(input.rules);
  const known = knownBadges(gameConfig);
  if (mode === "construct") return constructDecision(input, rules, known);
  return betDecision(input, rules, known);
}

module.exports = {
  VALID_MODES,
  decide,
  solveConstruction,
};
