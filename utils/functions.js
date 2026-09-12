const { SOCKET_EVENT, ROLE, PORTAL_ROLES } = require("./enum.js");

const isPhoneNumber = (input) => {
    // Allows digits, spaces, +, -, and ()
    const phoneRegex = /^[0-9+\-()\s]+$/;
    const digitCount = input.replace(/\D/g, '').length;
    
    // It's a phone number if it matches the allowed characters AND has at least 4 digits
    return phoneRegex.test(input) && digitCount >= 2;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const httpError = (status, message) => new HttpError(status, message);

/*
  The sub-admin line, in one place.

  A sub-admin runs the portal but may neither make nor manage another portal
  account. Two separate things have to be refused for that to hold, and either
  one on its own leaves the rule ornamental:

    - granting a portal role, or a sub-admin simply creates an admin, or
      promotes a parent it already controls into one;
    - touching an account that already holds one, or a sub-admin demotes the
      real admin to parent and takes the top of the tree that way instead.

  Both are predicates rather than guards that throw, because the two callers
  answer differently: authController replies in the { errors } shape its form
  reads, usersController throws an httpError for the shared error handler.
*/
const canGrantRole = (actorRole, role) =>
  !PORTAL_ROLES.includes(role) || actorRole === ROLE.ADMIN;

const canManageUser = (actorRole, targetRole) =>
  !PORTAL_ROLES.includes(targetRole) || actorRole === ROLE.ADMIN;

/*
  Which school this caller is confined to, or null for "every school".

  Every scoped query in the app reads its filter from here, so the one thing
  that must never happen is a school account resolving to null: null is not a
  neutral value, it is full access to all four schools. The role is therefore
  what decides, and the id is only consulted after it.

  A school account whose link has gone - its school deleted, or the row never
  written - is refused outright rather than falling through to unscoped. That is
  the direction this has to fail in: an account that manages no school should be
  able to do nothing, not everything.
*/
const NO_SCHOOL = -1;

const schoolScope = (user) => {
  if (user?.role !== ROLE.SCHOOL) return null;
  return Number.isInteger(user.schoolid) ? user.schoolid : NO_SCHOOL;
};

//True when this caller may touch rows belonging to `schoolid`. Reads naturally
//at a call site - assertInScope(req.user, route.schoolid) - and keeps the
//null-means-everything rule in one place rather than at every comparison.
const inSchoolScope = (user, schoolid) => {
  const scope = schoolScope(user);
  return scope === null || (schoolid != null && Number(schoolid) === scope);
};

/*
  Out of scope is answered as 404, never 403.

  403 would confirm the row exists, which hands a school account a way to probe
  another school's routes and students one id at a time. "Not yours" and "not
  there" must be indistinguishable from outside.
*/
const assertInScope = (user, schoolid, what = "record") => {
  if (!inSchoolScope(user, schoolid)) throw httpError(404, `No ${what} with this id`);
};

/*
  The school filter a list endpoint should actually run.

  For a school account its own school always wins, whatever the query string
  asked for: the filter is a convenience for an admin choosing among schools,
  and a constraint for everyone else. Returning the requested value for an
  unscoped caller leaves those endpoints behaving exactly as before.
*/
const scopedSchoolFilter = (user, requested) => schoolScope(user) ?? requested;

/*
  Socket answers. A socket handler has no res and no next, so it can never
  reach the express error handler in app.js - these two stand in for it.
  The ack callback is optional: socket.io only passes one when the client
  emitted with an acknowledgement, so every call is guarded.
*/
const socketOk = (ack, data = {}) => {
  if(typeof ack === "function") ack({ok: true, ...data});
};

const socketError = (socket, ack, err) => {
  const status = err.status || 500;
  const message = err.message || "Internal Server error";

  if(typeof ack === "function") ack({ok: false, status, message});
  //Also emitted, because a client can subscribe to failures it did not ask
  //for an acknowledgement on.
  socket.emit(SOCKET_EVENT.ROOM_ERROR, {status, message});
};

module.exports = {
  isPhoneNumber,
  HttpError,
  httpError,
  canGrantRole,
  canManageUser,
  schoolScope,
  inSchoolScope,
  assertInScope,
  scopedSchoolFilter,
  NO_SCHOOL,
  socketOk,
  socketError
}