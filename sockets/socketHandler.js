const { SOCKET_EVENT } = require("../utils/enum.js");
const { authenticateSocket } = require("../utils/authMiddleware.js");
const { Server } = require("socket.io");

/*
    Required lazily, not at the top. The controller needs getIO() from this
    file, so importing it up here would be a cycle and one of the two would
    get a half-built module. By the time a socket connects both files are
    fully loaded and require() is just a cache hit.
*/
const controller = () => require("../controller/usersController.js");

let io = null;

function socketHandler (server) {
    io = new Server(server, {
      cors: {
        origin: process.env.ORIGIN,
        credentials: true
      }
    });

    io.use(authenticateSocket);

    io.on("connection", (socket) => {
      /*
          THE ROOMS THIS ACCOUNT MUST NOT MISS, JOINED BEFORE IT ASKS.

          A reconnect is a new socket in no rooms, and the client is told
          nothing about it: it reports connected, and then receives nothing
          for the rest of the run. That is every redeploy, every tunnel and
          every lift - and it is the main reason a driver's status change
          "doesn't arrive" on another device.

          So a driver lands in their own route's room and a parent in their own
          family room on every single connection, including the silent ones
          after a drop. Nothing is remembered between connections - the rooms
          are derived from the account, so this survives the process dying.
          See roomsForUser in storage/usersQuery.js for what is deliberately
          left out of it.

          Failure is logged and swallowed. A socket that cannot be pre-joined
          is still a working socket: it can ask for its rooms the old way, and
          refusing the connection over this would be a worse outcome than a
          client that has to re-join.
      */
      controller().joinStandingRooms(socket);

      //Joining is authorized now: a room carries live child locations.
      socket.on(SOCKET_EVENT.JOIN, (routeid, ack) => {
        controller().handleRouteJoin(socket, routeid, ack);
      });
      socket.on(SOCKET_EVENT.LEAVE, (routeid) => {
        socket.leave(`route:${routeid}`);
      });
      /*
          The parent side of the same idea, and a separate pair of events
          rather than a role check inside the two above: the rooms they join
          are different rooms carrying different payloads, and a parent who
          sent route:join by mistake should be refused rather than quietly
          given something else.
      */
      socket.on(SOCKET_EVENT.FAMILY_JOIN, (routeid, ack) => {
        controller().handleFamilyJoin(socket, routeid, ack);
      });
      socket.on(SOCKET_EVENT.FAMILY_LEAVE, (routeid) => {
        controller().handleFamilyLeave(socket, routeid);
      });
      //Driver -> server. The server re-broadcasts as BUS_LOCATION.
      socket.on(SOCKET_EVENT.DRIVER_LOCATION, (payload, ack) => {
        controller().handleDriverLocation(socket, payload, ack);
      });
    });

    return io;
}

function getIO() {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
}

module.exports = {
    socketHandler,
    getIO
}
