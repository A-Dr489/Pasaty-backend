const { SOCKET_EVENT } = require("../utils/enum.js");
const socketJoinRoom = require("./socketJoin.js");

module.exports = (io) => {
    io.on("connection", (socket) => {
        socket.on(SOCKET_EVENT.JOIN, (routeid) => {
            socketJoinRoom(socket, routeid);
        });
    });
}