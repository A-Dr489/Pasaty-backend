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
  socketOk,
  socketError
}