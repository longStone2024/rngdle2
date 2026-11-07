"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createApiHandler } = require("../api");
const { createUserService } = require("../users");

function createResponse() {
  return {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function send(api, method, pathname, token, body, cookie = "") {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
    host: "localhost",
  };
  const response = createResponse();
  return api.handle(req, response, new URL(`http://localhost${pathname}`))
    .then(() => ({ status: response.status, headers: response.headers, body: response.body ? JSON.parse(response.body) : null }));
}

async function fixture(t) {
  const previous = {
    ROOT_USERNAME: process.env.ROOT_USERNAME,
    ROOT_PASSWORD: process.env.ROOT_PASSWORD,
    OAUTH_ENCRYPTION_KEY: process.env.OAUTH_ENCRYPTION_KEY,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.ROOT_USERNAME = "root_admin";
  process.env.ROOT_PASSWORD = "root-test-password-long";
  process.env.OAUTH_ENCRYPTION_KEY = "test-key-material-at-least-thirty-two-characters";
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.NODE_ENV;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rngdle-oauth-admin-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, "store.json");
  const users = createUserService(dataFile);
  await users.load();
  const api = createApiHandler(users);
  const rootLogin = await users.login({ username: "root_admin", password: "root-test-password-long" });
  return { api, dataFile, directory, users, rootToken: rootLogin.token };
}

const providerInput = {
  id: "example-idp",
  name: "Example Identity",
  enabled: true,
  clientId: "client-id",
  clientSecret: "client-secret-plaintext",
  authorizationUrl: "https://identity.example/authorize",
  tokenUrl: "https://identity.example/token",
  userInfoUrl: "https://identity.example/userinfo",
  scopes: "openid profile email",
  subjectField: "sub",
};

function makeOidcToken(claims, secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

test("root bootstrap, provider secrets, and administrator endpoints are protected", async (t) => {
  const { api, directory, users, rootToken } = await fixture(t);
  const rootProfile = await send(api, "GET", "/api/me", rootToken);
  assert.equal(rootProfile.body.role, "admin");
  assert.equal(rootProfile.body.isRoot, true);

  const registered = await users.register({ username: "regular_user", password: "regular-test-password" });
  await assert.rejects(
    send(api, "GET", "/api/admin/overview", registered.token),
    { status: 403 },
  );
  const overview = await send(api, "GET", "/api/admin/overview", rootToken);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.userCount, 2);

  const created = await send(api, "POST", "/api/admin/oauth/providers", rootToken, providerInput);
  assert.equal(created.status, 201);
  assert.equal(created.body.provider.hasClientSecret, true);
  assert.equal(Object.hasOwn(created.body.provider, "clientSecret"), false);
  const persisted = await fs.readFile(path.join(directory, "store.json"), "utf8");
  assert.equal(persisted.includes(providerInput.clientSecret), false);
  assert.equal((await send(api, "GET", "/api/auth/oauth/providers")).body.providers.length, 1);
  await assert.rejects(
    send(api, "POST", "/api/auth/register", "", { username: "password_signup", password: "long-password-for-test" }),
    { status: 403 },
  );

  await assert.rejects(
    send(api, "DELETE", "/api/admin/users/root_admin", rootToken),
    { status: 400 },
  );
  await assert.rejects(
    send(api, "PATCH", "/api/admin/users/root_admin", rootToken, { disabled: true }),
    { status: 400 },
  );
});

test("users can change their password without changing username and root bootstrap does not reset it", async (t) => {
  const { api, dataFile, users, rootToken } = await fixture(t);
  const root = users.authenticate({ headers: { authorization: `Bearer ${rootToken}` } });
  const apiToken = await users.createApiToken(root.user, "password-change-check", ["target"]);
  const otherSession = (await users.login({
    username: "root_admin",
    password: "root-test-password-long",
  })).token;

  await assert.rejects(
    send(api, "PUT", "/api/me/password", rootToken, {
      currentPassword: "wrong-current-password",
      newPassword: "updated-root-password-long",
    }),
    { status: 401 },
  );
  await assert.rejects(
    send(api, "PUT", "/api/me/password", apiToken.token, {
      currentPassword: "root-test-password-long",
      newPassword: "updated-root-password-long",
    }),
    { status: 403 },
  );
  const changed = await send(api, "PUT", "/api/me/password", rootToken, {
    currentPassword: "root-test-password-long",
    newPassword: "updated-root-password-long",
    username: "renamed_root",
  });
  assert.equal(changed.status, 200);
  assert.equal(users.authenticate({ headers: { authorization: `Bearer ${rootToken}` } }).username, "root_admin");
  assert.equal(users.authenticate({ headers: { authorization: `Bearer ${otherSession}` } }), null);
  assert.equal((await send(api, "GET", "/api/me", rootToken)).body.username, "root_admin");
  await assert.rejects(
    users.login({ username: "root_admin", password: "root-test-password-long" }),
    { status: 401 },
  );
  await users.login({ username: "root_admin", password: "updated-root-password-long" });

  const reloadedUsers = createUserService(dataFile);
  await reloadedUsers.load();
  await reloadedUsers.login({ username: "root_admin", password: "updated-root-password-long" });
  await assert.rejects(
    reloadedUsers.login({ username: "root_admin", password: "root-test-password-long" }),
    { status: 401 },
  );
});

test("OAuth login uses provider subject, does not merge matching email, and consumes state once", async (t) => {
  const { api, users } = await fixture(t);
  const existing = await users.register({ username: "same_email", password: "existing-password-long" });
  await users.saveOAuthProvider(providerInput);
  const oauthState = users.createOAuthState("example-idp", "login");
  assert.throws(() => users.consumeOAuthState("wrong-state", "example-idp"), /state/);
  const stateRecord = users.consumeOAuthState(
    oauthState.state,
    "example-idp",
    oauthState.browserBinding,
  );
  assert.equal(stateRecord.flow, "login");
  assert.throws(() => users.consumeOAuthState(oauthState.state, "example-idp"), /state/);

  const authorization = await send(api, "GET", "/api/auth/oauth/example-idp/start?flow=register");
  assert.equal(authorization.status, 200);
  assert.match(authorization.headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
  const authorizationUrl = new URL(authorization.body.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationUrl.searchParams.get("code_challenge"));
  const state = authorizationUrl.searchParams.get("state");
  const cookie = authorization.headers["Set-Cookie"].split(";", 1)[0];
  const originalFetch = global.fetch;
  let verifier = "";
  global.fetch = async (target, options = {}) => {
    if (String(target) === providerInput.tokenUrl) {
      const body = new URLSearchParams(options.body);
      verifier = body.get("code_verifier");
      return { ok: true, status: 200, json: async () => ({ access_token: "mock-access-token" }) };
    }
    assert.equal(String(target), providerInput.userInfoUrl);
    assert.equal(options.headers.Authorization, "Bearer mock-access-token");
    return {
      ok: true,
      status: 200,
      json: async () => ({ sub: "stable-subject", email: "same_email@example.com", preferred_username: "same_email" }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });
  const callback = await send(
    api,
    "GET",
    `/api/auth/oauth/example-idp/callback?state=${encodeURIComponent(state)}&code=mock-code`,
    undefined,
    undefined,
    cookie,
  );
  assert.equal(callback.status, 302);
  assert.match(callback.headers["Set-Cookie"], /Max-Age=0/);
  const token = new URL(callback.headers.Location, "http://localhost").hash
    .slice(1)
    .replace("oauth_token=", "");
  const challenge = authorizationUrl.searchParams.get("code_challenge");
  const calculatedChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(calculatedChallenge, challenge);
  const oauthAuth = users.authenticate({ headers: { authorization: `Bearer ${decodeURIComponent(token)}` } });
  assert.ok(oauthAuth);
  assert.notEqual(oauthAuth.username, "same_email");
  assert.equal(users.authenticate({ headers: { authorization: `Bearer ${existing.token}` } }).username, "same_email");
  await assert.rejects(
    users.loginWithOAuth("example-idp", "new-login-subject", {}, "login"),
    { status: 404 },
  );
  const newOAuthUser = await users.loginWithOAuth("example-idp", "new-register-subject", { username: "new_oauth_user" }, "register");
  const existingOAuthLogin = await users.loginWithOAuth("example-idp", "new-register-subject", {}, "login");
  assert.equal(newOAuthUser.user.username, existingOAuthLogin.user.username);
  await assert.rejects(
    users.loginWithOAuth("example-idp", "new-register-subject", {}, "register"),
    { status: 409 },
  );
  const replay = await send(
    api,
    "GET",
    `/api/auth/oauth/example-idp/callback?state=${encodeURIComponent(state)}&code=mock-code`,
    undefined,
    undefined,
    cookie,
  );
  assert.equal(replay.status, 302);
  assert.match(replay.headers.Location, /oauth_error=/);
  const csrfAuthorization = await send(api, "GET", "/api/auth/oauth/example-idp/start?flow=login");
  const csrfState = new URL(csrfAuthorization.body.authorizationUrl).searchParams.get("state");
  const csrfCallback = await send(
    api,
    "GET",
    `/api/auth/oauth/example-idp/callback?state=${encodeURIComponent(csrfState)}&code=mock-code`,
  );
  assert.equal(csrfCallback.status, 302);
  assert.match(csrfCallback.headers.Location, /oauth_error=/);
});

test("OAuth identities cannot be hijacked and the last usable login cannot be removed", async (t) => {
  const { users } = await fixture(t);
  await users.saveOAuthProvider(providerInput);
  const oauthUser = await users.loginWithOAuth("example-idp", "one-subject", { username: "oauth_person" }, "register");
  const conflict = await users.bindOAuthIdentity("root_admin", "example-idp", "one-subject")
    .then(() => null, (error) => error);
  assert.equal(conflict.status, 409);

  const cannotDeleteProvider = await users.deleteOAuthProvider("example-idp")
    .then(() => null, (error) => error);
  assert.equal(cannotDeleteProvider.status, 409);
  const cannotUnlinkLastLogin = await users.unlinkOAuthIdentity(oauthUser.user.username, "example-idp")
    .then(() => null, (error) => error);
  assert.equal(cannotUnlinkLastLogin.status, 400);
  const cannotChangeMissingPassword = await users.changePassword(
    users.authenticate({ headers: { authorization: `Bearer ${oauthUser.token}` } }).user,
    "",
    "new-password-long",
    users.authenticate({ headers: { authorization: `Bearer ${oauthUser.token}` } }).tokenHash,
  ).then(() => null, (error) => error);
  assert.equal(cannotChangeMissingPassword.status, 400);
});

test("OpenID Connect provider can authenticate using a verified ID token without PKCE or user-info endpoint", async (t) => {
  const { api, users } = await fixture(t);
  const codeforces = {
    ...providerInput,
    id: "codeforces",
    name: "Codeforces",
    userInfoUrl: "",
    issuer: "https://codeforces.com",
    scopes: "openid",
    subjectField: "sub",
    pkceEnabled: false,
  };
  await users.saveOAuthProvider(codeforces);
  assert.equal(users.getOAuthProvider("codeforces").issuer, codeforces.issuer);

  const authorization = await send(api, "GET", "/api/auth/oauth/codeforces/start?flow=register");
  const authorizationUrl = new URL(authorization.body.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("scope"), "openid");
  assert.equal(authorizationUrl.searchParams.has("code_challenge"), false);
  assert.ok(authorizationUrl.searchParams.get("nonce"));
  const state = authorizationUrl.searchParams.get("state");
  const nonce = authorizationUrl.searchParams.get("nonce");
  const cookie = authorization.headers["Set-Cookie"].split(";", 1)[0];
  const originalFetch = global.fetch;
  global.fetch = async (target, options = {}) => {
    assert.equal(String(target), codeforces.tokenUrl);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("client_id"), codeforces.clientId);
    assert.equal(body.get("client_secret"), codeforces.clientSecret);
    assert.equal(body.has("code_verifier"), false);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mock-access-token",
        id_token: makeOidcToken({
          iss: codeforces.issuer,
          aud: codeforces.clientId,
          exp: Math.floor(Date.now() / 1000) + 60,
          nonce,
          sub: "cf-user-123",
          handle: "CodeforcesUser",
        }, codeforces.clientSecret),
      }),
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  const callback = await send(
    api,
    "GET",
    `/api/auth/oauth/codeforces/callback?state=${encodeURIComponent(state)}&code=mock-code`,
    undefined,
    undefined,
    cookie,
  );
  assert.equal(callback.status, 302);
  const oauthToken = new URLSearchParams(new URL(callback.headers.Location, "http://localhost").hash.slice(1))
    .get("oauth_token");
  const auth = users.authenticate({ headers: { authorization: `Bearer ${oauthToken}` } });
  assert.equal(auth.username, "codeforcesuser");
  await assert.rejects(
    users.saveOAuthProvider({ ...codeforces, issuer: "https://another-issuer.example" }, "codeforces"),
    { status: 409 },
  );

  async function expectRejectedIdToken(tokenForNonce) {
    const nextAuthorization = await send(api, "GET", "/api/auth/oauth/codeforces/start?flow=register");
    const nextUrl = new URL(nextAuthorization.body.authorizationUrl);
    const nextState = nextUrl.searchParams.get("state");
    const nextNonce = nextUrl.searchParams.get("nonce");
    const nextCookie = nextAuthorization.headers["Set-Cookie"].split(";", 1)[0];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "mock-access-token",
        id_token: tokenForNonce(nextNonce),
      }),
    });
    const failedCallback = await send(
      api,
      "GET",
      `/api/auth/oauth/codeforces/callback?state=${encodeURIComponent(nextState)}&code=mock-code`,
      undefined,
      undefined,
      nextCookie,
    );
    assert.equal(failedCallback.status, 302);
    assert.match(new URL(failedCallback.headers.Location, "http://localhost").searchParams.get("oauth_error"), /OAuth 登录失败/);
  }

  await expectRejectedIdToken(() => makeOidcToken({
    iss: codeforces.issuer,
    aud: codeforces.clientId,
    exp: Math.floor(Date.now() / 1000) + 60,
    nonce: "incorrect-nonce",
    sub: "cf-user-bad-nonce",
  }, codeforces.clientSecret));
  await expectRejectedIdToken((expectedNonce) => makeOidcToken({
    iss: codeforces.issuer,
    aud: codeforces.clientId,
    exp: Math.floor(Date.now() / 1000) + 60,
    nonce: expectedNonce,
    sub: "cf-user-bad-signature",
  }, "incorrect-client-secret"));
});
