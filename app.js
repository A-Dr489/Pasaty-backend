require("dotenv").config();
const express = require("express");
const app = express();
const http = require("http");
const { Server } = require('socket.io');
const server = http.createServer(app);
const cors = require("cors");
const cookieParser = require('cookie-parser');
const authRouter = require("./routes/authRouter.js");
const protectedRouter = require("./routes/protectedRouter.js");
const usersRouter = require("./routes/usersRouter.js");
const routesRouter = require("./routes/routesRouter.js");
const socketHandler = require("./sockets/socketHandler.js");
const { authenticateSocket } = require("./utils/authMiddleware.js");

const corsOptions = {origin: [process.env.ORIGIN], credentials: true}
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use("/v1/auth", authRouter);
app.use("/v1/protected", protectedRouter);
app.use("/v1/users", usersRouter);
app.use("/v1/routes", routesRouter);
app.get("/test", (req, res) => {
    res.json({message: "Request Worked"});
})

const io = new Server(server, {
  cors: {
    origin: process.env.ORIGIN,
    methods: ["GET", "POST"],
    // credentials: true
  }
});

io.use(authenticateSocket);

socketHandler(io);

const PORT = Number(process.env.PORT);
server.listen(PORT, () => {
    console.log("Server is listening to Port: " + PORT);
})