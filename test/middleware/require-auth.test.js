import assert from "node:assert/strict";
import test from "node:test";
import requireAuth from "../../src/middleware/require-auth.js";

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("rejects a request without a session", () => {
  const response = createResponse();
  let nextCalled = false;

  requireAuth({}, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { message: "Please log in to continue" });
  assert.equal(nextCalled, false);
});

test("rejects a session without a user ID", () => {
  const response = createResponse();
  let nextCalled = false;

  requireAuth({ session: { user: { tenantId: "42" } } }, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects a session without a tenant ID", () => {
  const response = createResponse();
  let nextCalled = false;

  requireAuth({ session: { user: { id: "7" } } }, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("allows an authenticated user with a tenant ID", () => {
  const response = createResponse();
  let nextCalled = false;

  requireAuth({ session: { user: { id: "7", tenantId: "42" } } }, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, null);
  assert.equal(nextCalled, true);
});
