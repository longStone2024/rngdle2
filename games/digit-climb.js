"use strict";

const { createKnownBadgeScorer, scoreKnownBadges } = require("../official-engine");
const { knownBadges, DecisionInputError } = require("./common");

const MAX_NUMBER = 999_999;
const MIN_NUMBER = 0;
const ALLOWED_BUDGETS = [3, 3.5, 5, 5.5, 7, 7.5];

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].cost <= item.cost) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length
          && this.items[right].cost < this.items[left].cost
          ? right
          : left;
        if (this.items[child].cost >= last.cost) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }

  get size() {
    return this.items.length;
  }
}

function validateNumber(number, label) {
  if (!Number.isInteger(number) || number < MIN_NUMBER || number > MAX_NUMBER) {
    throw new DecisionInputError(`${label} must be an integer between ${MIN_NUMBER} and ${MAX_NUMBER}, interpreted as a six-digit number`);
  }
}

function addNeighbor(neighbors, digits, cost) {
  neighbors.push({ digits, cost });
}

function getNeighbors(digits) {
  const neighbors = [];
  for (let position = 0; position < 6; position++) {
    const digit = Number(digits[position]);
    if (digit > 0) {
      const changed = [...digits];
      changed[position] = String(digit - 1);
      addNeighbor(neighbors, changed.join(""), 2);
    }
    if (digit < 9) {
      const changed = [...digits];
      changed[position] = String(digit + 1);
      addNeighbor(neighbors, changed.join(""), 2);
    }
    for (let replacement = 0; replacement <= 9; replacement++) {
      if (replacement === digit) continue;
      const changed = [...digits];
      changed[position] = String(replacement);
      addNeighbor(neighbors, changed.join(""), 6);
    }
  }
  for (let position = 0; position < 5; position++) {
    const changed = [...digits];
    [changed[position], changed[position + 1]] = [changed[position + 1], changed[position]];
    addNeighbor(neighbors, changed.join(""), 3);
  }
  return neighbors;
}

function compareSolutions(left, right) {
  return right.score - left.score || left.cost - right.cost || right.number - left.number;
}

function decide(input, gameConfig) {
  const number = input.number;
  const budget = input.budget;
  validateNumber(number, "number");
  if (!ALLOWED_BUDGETS.includes(budget)) {
    throw new DecisionInputError(`budget must be one of ${ALLOWED_BUDGETS.join(", ")}`);
  }
  if (input.answer !== undefined) validateNumber(input.answer, "answer");

  const maxCost = budget * 2;
  const start = String(number).padStart(6, "0");
  const distances = new Map([[start, 0]]);
  const queue = new MinHeap();
  queue.push({ digits: start, cost: 0 });
  const known = knownBadges(gameConfig);
  const scoreKnown = createKnownBadgeScorer(known);
  const best = [];

  while (queue.size > 0) {
    const current = queue.pop();
    if (distances.get(current.digits) !== current.cost) continue;
    const currentNumber = Number(current.digits);
    const candidate = {
      number: currentNumber,
      cost: current.cost / 2,
      score: scoreKnown(currentNumber),
    };
    best.push(candidate);
    best.sort(compareSolutions);
    if (best.length > 5) best.pop();

    for (const neighbor of getNeighbors(current.digits)) {
      const cost = current.cost + neighbor.cost;
      if (cost > maxCost || (distances.has(neighbor.digits) && distances.get(neighbor.digits) <= cost)) {
        continue;
      }
      distances.set(neighbor.digits, cost);
      queue.push({ digits: neighbor.digits, cost });
    }
  }

  const solutions = best.map(({ number: result, cost, score }) => {
    const scoring = scoreKnownBadges(result, known);
    return {
      number: result,
      cost,
      score,
      matched: scoring.matched,
      scoringBadges: scoring.scoringBadges,
    };
  });
  const decision = {
    game: "climb",
    number,
    budget,
    solutions,
    knowledgeUsed: solutions[0].matched.length,
  };
  if (input.answer !== undefined) {
    const answerCost = distances.get(String(input.answer).padStart(6, "0"));
    if (answerCost === undefined || answerCost > maxCost) {
      throw new DecisionInputError(`answer cannot be reached within budget ${budget}`);
    }
    const scoring = scoreKnownBadges(input.answer, known);
    decision.answer = {
      number: input.answer,
      cost: answerCost / 2,
      score: scoring.score,
      matched: scoring.matched,
      scoringBadges: scoring.scoringBadges,
    };
  }
  return decision;
}

module.exports = { ALLOWED_BUDGETS, decide };
