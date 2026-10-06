import assert from "node:assert/strict";
import test from "node:test";
import requireRole from "../../src/middleware/require-role.js";

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

test("returns 401 when the request has no signed-in user", () => {
  const response = createResponse();
  let nextCalled = false;

  requireRole("tenant_admin")({}, response, () => {
    nextCalled = true;
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { message: "Please log in to continue." });
  assert.equal(nextCalled, false);
});

test("returns 403 when a signed-in user lacks the required role", () => {
  const response = createResponse();
  let nextCalled = false;

  requireRole("tenant_admin")(
    { session: { user: { id: "8", role: "tenant_staff" } } },
    response,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    message: "You do not have permission to do that.",
  });
  assert.equal(nextCalled, false);
});

test("allows a user with the required role", () => {
  const response = createResponse();
  let nextCalled = false;

  requireRole("tenant_admin")(
    { session: { user: { id: "8", role: "tenant_admin" } } },
    response,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(response.statusCode, null);
  assert.equal(nextCalled, true);
});

test("allows a user matching any one of multiple permitted roles", () => {
  const response = createResponse();
  let nextCalled = false;

  requireRole("tenant_admin", "tenant_staff")(
    { session: { user: { id: "8", role: "tenant_staff" } } },
    response,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(response.statusCode, null);
  assert.equal(nextCalled, true);
});
