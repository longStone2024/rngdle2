"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiHandler } = require("../api");

function createResponse() {
  return {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("public status exposes the official features used by the configuration UI", async () => {
  const api = createApiHandler({});
  const response = createResponse();
  await api.handle(
    { method: "GET", headers: {} },
    response,
    new URL("http://localhost/api/status"),
  );

  const payload = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.deepEqual(payload.games, ["composition", "collection", "target", "climb"]);
  assert.equal(Array.isArray(payload.features), true);
  assert.equal(payload.features.length, 233);
  assert.equal(payload.features.some(({ id }) => id === "VOID"), true);
  assert.equal(payload.features.every(({ descriptionZh }) => typeof descriptionZh === "string" && descriptionZh.length > 0), true);
  assert.equal(payload.features.every(({ description, descriptionZh }) => description !== descriptionZh), true);
  assert.equal(payload.features.some(({ descriptionZh }) => descriptionZh.startsWith("计分条件：")), false);
  assert.deepEqual(
    Object.fromEntries(["Math", "Digits", "Easter eggs"].map((category) => [
      category,
      payload.features.filter((feature) => feature.category === category).length,
    ])),
    { Math: 42, Digits: 130, "Easter eggs": 61 },
  );
  assert.equal(payload.features.find(({ id }) => id === "ONE_MILLION").category, "Digits");
});
