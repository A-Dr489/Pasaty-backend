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
      //Joining is authorized now: a room carries live child locations.
      socket.on(SOCKET_EVENT.JOIN, (routeid, ack) => {
        controller().handleRouteJoin(socket, routeid, ack);
      });
      socket.on(SOCKET_EVENT.LEAVE, (routeid) => {
        socket.leave(`route:${routeid}`);
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
