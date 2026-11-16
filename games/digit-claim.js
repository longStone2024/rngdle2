"use strict";

const {
  createKnownBadgeScorer,
  scoreKnownBadges,
} = require("../official-engine");
const { knownBadges, DecisionInputError } = require("./common");

// Digit Claim is a 1v1 drafting game. A single pool of 14 digits is shared;
// the two players take turns claiming one digit each. The fixed claim order is
// A B B A A B B A A B B A A B, so both sides end up with seven digits. Each
// side has six fixed slots (left to right, forming the scored number) plus one
// free cell used as a one-digit buffer. The free-cell digit can be moved into
// an empty fixed slot on a later turn; the digit left in the free cell at the
// end is discarded. The winner is the side with the higher official badge EP.
const FIXED_SLOTS = 6;
const POOL_SIZE = 14;
const CLAIM_ORDER = "ABBAABBAABBAAB";
const DEFAULT_CLAIM_SECONDS = 60;

// Scoring a six-digit number is the dominant cost, so results are memoised per
// scorer. The caches are bounded: clearing them is safe (they are only an
// optimization) and keeps a long-lived server from growing without limit.
const SCORE_CACHE_LIMIT = 200_000;
const MEMO_LIMIT = 200_000;

const scorerCache = new Map();

function getScorer(known) {
  const signature = [...known].sort().join(",");
  let entry = scorerCache.get(signature);
  if (entry) return entry;
  entry = {
    known,
    scorer: createKnownBadgeScorer(known),
    scoreCache: new Map(),
    handCache: new Map(),
    gameCache: new Map(),
  };
  scorerCache.set(signature, entry);
  return entry;
}

function getScore(entry, numberString) {
  const cached = entry.scoreCache.get(numberString);
  if (cached !== undefined) return cached;
  const score = entry.scorer(Number(numberString));
  if (entry.scoreCache.size >= SCORE_CACHE_LIMIT) entry.scoreCache.clear();
  entry.scoreCache.set(numberString, score);
  return score;
}

function cacheSet(map, key, value, limit) {
  if (map.size >= limit) map.clear();
  map.set(key, value);
}

function isDigit(value) {
  return Number.isInteger(value) && value >= 0 && value <= 9;
}

function isSlotValue(value) {
  return value === null || value === undefined || value === "" || isDigit(value);
}

function normalizeSlots(value, label, length) {
  if (!Array.isArray(value) || value.length !== length
      || value.some((slot) => !isSlotValue(slot))) {
    throw new DecisionInputError(`${label} must contain exactly ${length} digits (or null) between 0 and 9`);
  }
  return value.map((slot) => (isDigit(slot) ? slot : null));
}

function normalizeFree(value, label) {
  if (!isSlotValue(value)) {
    throw new DecisionInputError(`${label} must be a digit between 0 and 9 or null`);
  }
  return isDigit(value) ? value : null;
}

function countDigits(digits) {
  const counts = new Array(10).fill(0);
  for (const digit of digits) counts[digit] += 1;
  return counts;
}

function heldDigits(fixed, free) {
  const digits = [];
  for (const slot of fixed) if (slot !== null) digits.push(slot);
  if (free !== null) digits.push(free);
  return digits;
}

function resolveClaimCounts(input) {
  if (Number.isInteger(input.claimsRemaining) && input.claimsRemaining >= 1) {
    const mine = input.claimsRemaining;
    const opp = Number.isInteger(input.opponentClaimsRemaining)
      && input.opponentClaimsRemaining >= 0
      ? input.opponentClaimsRemaining
      : Math.max(0, mine - 1);
    return { mine, opp };
  }
  if (typeof input.order === "string" && Number.isInteger(input.index)) {
    const order = input.order;
    if (order.length === 0 || input.index < 0 || input.index >= order.length) {
      throw new DecisionInputError("order/index do not describe a valid claim position");
    }
    const player = order[input.index];
    if (player !== "A" && player !== "B") {
      throw new DecisionInputError("order must only contain A and B");
    }
    let mine = 0;
    let opp = 0;
    for (let position = input.index; position < order.length; position++) {
      if (order[position] === player) mine += 1;
      else opp += 1;
    }
    return { mine, opp };
  }
  throw new DecisionInputError("provide claimsRemaining (and optionally opponentClaimsRemaining) or order with index");
}

function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DecisionInputError("claim decision requires a state object");
  }
  if (!Array.isArray(input.pool) || input.pool.length > POOL_SIZE
      || input.pool.some((digit) => !isDigit(digit))) {
    throw new DecisionInputError(`pool must contain at most ${POOL_SIZE} digits between 0 and 9`);
  }
  const fixed = normalizeSlots(input.fixed, "fixed", FIXED_SLOTS);
  const free = normalizeFree(input.free, "free");

  let oppFixed = new Array(FIXED_SLOTS).fill(null);
  let oppFree = null;
  if (input.opponent !== undefined && input.opponent !== null) {
    if (typeof input.opponent !== "object" || Array.isArray(input.opponent)) {
      throw new DecisionInputError("opponent must be an object with fixed and free");
    }
    oppFixed = normalizeSlots(input.opponent.fixed, "opponent.fixed", FIXED_SLOTS);
    oppFree = normalizeFree(input.opponent.free, "opponent.free");
  }

  const { mine, opp } = resolveClaimCounts(input);
  return {
    pool: input.pool.slice(),
    fixed,
    free,
    oppFixed,
    oppFree,
    claimsRemaining: mine,
    opponentClaimsRemaining: opp,
  };
}

// Best six-digit arrangement that can be formed by filling the empty fixed
// slots from `available` (the free digit plus the extra digits). Each digit is
// used at most once; when more digits are available than empty slots the best
// subset is chosen. Returns null when there are not enough digits.
function bestCompleteScore(entry, fixed, free, extraDigits) {
  const emptyIndices = [];
  for (let index = 0; index < FIXED_SLOTS; index++) {
    if (fixed[index] === null) emptyIndices.push(index);
  }
  const needed = emptyIndices.length;
  const available = [];
  if (free !== null) available.push(free);
  for (const digit of extraDigits) available.push(digit);
  if (available.length < needed) return null;

  const key = `${fixed.map((slot) => (slot === null ? "_" : slot)).join("")}`
    + `|${[...available].sort((a, b) => a - b).join("")}`;
  const cached = entry.handCache.get(key);
  if (cached !== undefined) return cached;

  const sorted = [...available].sort((a, b) => a - b);
  const slots = fixed.slice();
  const used = new Array(sorted.length).fill(false);
  let best = null;

  const recurse = (position) => {
    if (position === needed) {
      const numberString = slots.join("");
      const score = getScore(entry, numberString);
      if (!best || score > best.score) {
        best = { score, number: Number(numberString), digits: numberString };
      }
      return;
    }
    const slot = emptyIndices[position];
    let previous = -1;
    for (let index = 0; index < sorted.length; index++) {
      if (used[index]) continue;
      if (previous === sorted[index]) continue;
      previous = sorted[index];
      used[index] = true;
      slots[slot] = sorted[index];
      recurse(position + 1);
      used[index] = false;
      slots[slot] = null;
    }
  };
  recurse(0);

  if (best) {
    const scoring = scoreKnownBadges(best.number, entry.known);
    best.matched = scoring.matched;
    best.scoringBadges = scoring.scoringBadges;
  }
  cacheSet(entry.handCache, key, best, MEMO_LIMIT);
  return best;
}

// Value of a fully-claimed hand: the best EP over the six digits placed in the
// fixed slots, which is the best six-of-seven arrangement (the free-cell digit
// is discarded). Memoised per multiset.
function handValue(entry, digits) {
  const sorted = [...digits].sort((a, b) => a - b).join("");
  const cached = entry.handCache.get(`hand|${sorted}`);
  if (cached !== undefined) return cached;
  const result = bestCompleteScore(entry, new Array(FIXED_SLOTS).fill(null), null, digits);
  const value = result ? result.score : 0;
  cacheSet(entry.handCache, `hand|${sorted}`, value, MEMO_LIMIT);
  return value;
}

// Minimax over the remaining claims. The game is zero-sum and fully observable,
// so this is exact. A state is (A's remaining claim count, A's digit multiset,
// B's remaining claim count, B's digit multiset, pool multiset, turn). Because
// the pool is the complement of the two multisets, the pool is implied; the
// remaining-claim counts plus the multisets determine the turn. The value is
// A's final EP minus B's final EP from this state onward.
//
// Memoisation key: sorted A digits, sorted B digits, aRemaining, bRemaining.
// The pool is reconstructed as total - A - B, so it need not be stored.
//
// Alpha-beta is threaded through the search: A maximizes (raising the lower
// bound alpha), B minimizes (lowering the upper bound beta). A node whose
// sub-tree was cut off returns only a bound, so only nodes that were fully
// searched (no cutoff) are cached. Cached entries are therefore always exact
// and context-independent, which keeps the memo correct under any parent
// alpha/beta window (including an infinite one at the root).
function solveGame(entry, totalCounts, order, index,
  aRemaining, aDigits, bRemaining, bDigits, alpha, beta) {
  // Terminal: both hands are fully determined; score them.
  if (index >= order.length) {
    return handValue(entry, aDigits) - handValue(entry, bDigits);
  }

  const aSorted = [...aDigits].sort((x, y) => x - y).join("");
  const bSorted = [...bDigits].sort((x, y) => x - y).join("");
  // The pool is the complement of the held digits under this match's 14-digit
  // pool, so the pool's digit distribution (totalCounts) must be part of the
  // key. Without it, two matches that share the same badge-knowledge signature
  // but have different pools could produce the same key for genuinely
  // different states and be served a stale minimax value. The current turn is
  // also included so that custom claim orders reaching the same counts on a
  // different turn cannot collide.
  const totalSig = totalCounts.join(",");
  const key = `${order[index]}|${totalSig}|${aSorted}|${bSorted}|${aRemaining}|${bRemaining}`;
  const cached = entry.gameCache.get(key);
  if (cached !== undefined) return cached;

  const turn = order[index];
  const aCounts = countDigits(aDigits);
  const bCounts = countDigits(bDigits);
  const remaining = totalCounts.map((total, digit) => total - aCounts[digit] - bCounts[digit]);

  let best;
  let cut = false;
  if (turn === "A") {
    best = Number.NEGATIVE_INFINITY;
    for (let digit = 0; digit <= 9; digit += 1) {
      if (remaining[digit] <= 0) continue;
      aDigits.push(digit);
      aRemaining -= 1;
      remaining[digit] -= 1;
      const value = solveGame(entry, totalCounts, order, index + 1,
        aRemaining, aDigits, bRemaining, bDigits, alpha, beta);
      aDigits.pop();
      aRemaining += 1;
      remaining[digit] += 1;
      if (value > best) best = value;
      if (best > alpha) alpha = best;
      if (best >= beta) { cut = true; break; }
    }
  } else {
    best = Number.POSITIVE_INFINITY;
    for (let digit = 0; digit <= 9; digit += 1) {
      if (remaining[digit] <= 0) continue;
      bDigits.push(digit);
      bRemaining -= 1;
      remaining[digit] -= 1;
      const value = solveGame(entry, totalCounts, order, index + 1,
        aRemaining, aDigits, bRemaining, bDigits, alpha, beta);
      bDigits.pop();
      bRemaining += 1;
      remaining[digit] += 1;
      if (value < best) best = value;
      if (best < beta) beta = best;
      if (best <= alpha) { cut = true; break; }
    }
  }

  // Cache only exact values (no cutoff). A pruned node returns a bound, which
  // is meaningless outside this search window, so it must not be memoised.
  if (!cut) cacheSet(entry.gameCache, key, best, MEMO_LIMIT);
  return best;
}

function enumeratePlacements(fixed, free) {
  const emptyIndices = [];
  for (let index = 0; index < FIXED_SLOTS; index++) {
    if (fixed[index] === null) emptyIndices.push(index);
  }
  const placements = [];

  // Option 1: leave the free cell untouched.
  if (free === null) {
    placements.push({ moveFreeTo: null, placeSlot: null, placeFree: true });
  }
  for (const slot of emptyIndices) {
    placements.push({ moveFreeTo: null, placeSlot: slot, placeFree: false });
  }

  // Option 2: move the occupied free digit into an empty fixed slot, then put
  // the claimed digit into the freed free cell or another empty fixed slot.
  if (free !== null) {
    for (const moveTo of emptyIndices) {
      const remaining = emptyIndices.filter((slot) => slot !== moveTo);
      placements.push({ moveFreeTo: moveTo, placeSlot: null, placeFree: true });
      for (const slot of remaining) {
        placements.push({ moveFreeTo: moveTo, placeSlot: slot, placeFree: false });
      }
    }
  }
  return placements;
}

function applyPlacement(fixed, free, placement, digit) {
  const nextFixed = fixed.slice();
  let nextFree = free;
  if (placement.moveFreeTo !== null && placement.moveFreeTo !== undefined) {
    nextFixed[placement.moveFreeTo] = free;
    nextFree = null;
  }
  if (placement.placeFree) {
    nextFree = digit;
  } else if (placement.placeSlot !== null && placement.placeSlot !== undefined) {
    nextFixed[placement.placeSlot] = digit;
  }
  return { fixed: nextFixed, free: nextFree };
}

// Pick the placement that leaves the best six-of-seven hand once every future
// claim is filled optimally. Future digits are estimated from the pool.
function choosePlacement(entry, state, digit, futureDigits) {
  const placements = enumeratePlacements(state.fixed, state.free);
  let best = null;
  for (const placement of placements) {
    const next = applyPlacement(state.fixed, state.free, placement, digit);
    const nextNeeded = next.fixed.filter((slot) => slot === null).length;
    const capped = futureDigits.slice(0, Math.max(nextNeeded, Math.min(futureDigits.length, nextNeeded + 1)));
    const result = bestCompleteScore(entry, next.fixed, next.free, capped);
    const value = result ? result.score : Number.NEGATIVE_INFINITY;
    if (!best || value > best.value) {
      best = { placement, value, result };
    }
  }
  return best;
}

function decide(input, gameConfig) {
  const state = normalizeState(input);
  const known = knownBadges(gameConfig);
  const entry = getScorer(known);

  const myHeld = heldDigits(state.fixed, state.free);
  const oppHeld = heldDigits(state.oppFixed, state.oppFree);
  const totalCounts = countDigits([...state.pool, ...myHeld, ...oppHeld]);

  const order = typeof input.order === "string" && input.order.length > 0
    ? input.order
    : CLAIM_ORDER;
  const index = Number.isInteger(input.index) ? input.index : null;
  const startIndex = index === null
    ? order.length - state.claimsRemaining - state.opponentClaimsRemaining
    : index;

  if (startIndex < 0 || startIndex >= order.length) {
    throw new DecisionInputError("claim index is outside the claim order");
  }

  // Who is claiming now? The caller owns the boards in `fixed`/`free` and is
  // making this turn's claim, so the caller's side is exactly the side named at
  // the current index of the claim order. Supporting both A-first and B-first
  // (the random-first-player feature) requires relabelling A/B onto
  // myself/opponent below.
  const mySide = order[startIndex];
  const oppSide = mySide === "A" ? "B" : "A";

  // Remaining claims per side from the current index, by absolute A/B label.
  let aRemaining = 0;
  let bRemaining = 0;
  for (let position = startIndex; position < order.length; position += 1) {
    if (order[position] === "A") aRemaining += 1;
    else if (order[position] === "B") bRemaining += 1;
  }

  // state.claimsRemaining / opponentClaimsRemaining are relative to the current
  // claimant (my side), so validate against that side's absolute count.
  if ((mySide === "A" ? aRemaining : bRemaining) !== state.claimsRemaining
      || (oppSide === "A" ? aRemaining : bRemaining) !== state.opponentClaimsRemaining) {
    throw new DecisionInputError("claimsRemaining/opponentClaimsRemaining do not match the claim order");
  }

  // Relabel hands onto absolute A/B. solveGame always treats "A" as the
  // maximiser of (A EP - B EP) at its root, so its value is the A-side
  // differential regardless of the caller.
  const aDigits = mySide === "A" ? myHeld.slice() : oppHeld.slice();
  const bDigits = mySide === "A" ? oppHeld.slice() : myHeld.slice();

  const baseValue = solveGame(
    entry, totalCounts, order, startIndex,
    aRemaining, aDigits, bRemaining, bDigits, -Infinity, Infinity,
  );
  // The caller's own differential: mine if I am A, the negation if I am B.
  const myBaseValue = mySide === "A" ? baseValue : -baseValue;

  // Evaluate every legal claim and pick the one that maximises the caller's
  // exact minimax differential from the resulting state.
  const myCounts = countDigits(myHeld);
  const oppCounts = countDigits(oppHeld);
  const remaining = totalCounts.map((total, digit) => total - myCounts[digit] - oppCounts[digit]);

  const candidates = [];
  for (let digit = 0; digit <= 9; digit += 1) {
    if (remaining[digit] <= 0) continue;
    // Push the claimed digit onto my hand and decrement my side's count, then
    // remap onto the absolute A/B layout solveGame expects.
    let value;
    if (mySide === "A") {
      value = solveGame(
        entry, totalCounts, order, startIndex + 1,
        aRemaining - 1, [...myHeld, digit], bRemaining, oppHeld, -Infinity, Infinity,
      );
    } else {
      value = solveGame(
        entry, totalCounts, order, startIndex + 1,
        aRemaining, oppHeld, bRemaining - 1, [...myHeld, digit], -Infinity, Infinity,
      );
    }
    candidates.push({ digit, value: mySide === "A" ? value : -value });
  }

  if (candidates.length === 0) {
    throw new DecisionInputError("pool must contain at least one digit to claim");
  }

  candidates.sort((left, right) => right.value - left.value || left.digit - right.digit);
  const chosen = candidates[0];

  // Estimate the future digits the chosen side may still draw so the placement
  // suggestion is sensible; the exact value already accounts for optimal play.
  const futureDigits = state.pool
    .filter((value) => value !== chosen.digit)
    .slice(0, Math.max(0, FIXED_SLOTS - state.fixed.filter((slot) => slot !== null).length));

  const placement = choosePlacement(entry, state, chosen.digit, futureDigits);
  const projected = placement.result
    || bestCompleteScore(entry, state.fixed, state.free, [chosen.digit, ...state.pool]);

  return {
    game: "claim",
    claim: chosen.digit,
    placement: placement.placement,
    score: projected ? projected.score : 0,
    opponentScore: handValue(entry, oppHeld),
    gameValue: myBaseValue,
    claimValue: chosen.value,
    projectedNumber: projected ? projected.number : null,
    projectedDigits: projected ? projected.digits : null,
    matched: projected ? projected.matched : [],
    scoringBadges: projected ? projected.scoringBadges : [],
    knowledgeUsed: projected ? projected.matched.length : 0,
    claimOrder: order,
    claimSeconds: DEFAULT_CLAIM_SECONDS,
  };
}

module.exports = {
  CLAIM_ORDER,
  DEFAULT_CLAIM_SECONDS,
  FIXED_SLOTS,
  POOL_SIZE,
  bestCompleteScore,
  decide,
  handValue,
  solveGame,
};
