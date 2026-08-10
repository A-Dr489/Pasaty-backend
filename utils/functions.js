const { SOCKET_EVENT } = require("./enum.js");

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
  socketOk,
  socketError
}