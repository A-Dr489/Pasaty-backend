// import { SOCKET_EVENT } from "../utils/enum.js";
// import { authenticateSocket } from "../utils/authMiddleware.js";
// import { Server } from 'socket.io';

const { SOCKET_EVENT } = require("../utils/enum.js");
const { authenticateSocket } = require("../utils/authMiddleware.js");
const { Server } = require("socket.io");

let io = null;

export function socketHandler (server) {
    io = new Server(server, {
      cors: {
        origin: process.env.ORIGIN,
        credentials: true
      }
    });

    io.use(authenticateSocket);

    io.on("connection", (socket) => {
      socket.on(SOCKET_EVENT.JOIN, (routeid) => {
        socket.join(`route:${routeid}`);
      });
      socket.on(SOCKET_EVENT.LEAVE, (routeid) => {
        socket.leave(`route:${routeid}`);
      });
    });

    return io;
}

export function getIO() {
    if (!io) throw new Error('Socket.io not initialized');
    return io;
}