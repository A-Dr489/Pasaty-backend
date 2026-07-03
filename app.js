require("dotenv").config();
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const cors = require("cors");
const cookieParser = require('cookie-parser');
const authRouter = require("./routes/authRouter.js");
const protectedRouter = require("./routes/protectedRouter.js");
const usersRouter = require("./routes/usersRouter.js");
const routesRouter = require("./routes/routesRouter.js");
const attendanceRouter = require("./routes/AttendanceRouter.js");
const { socketHandler } = require("./sockets/socketHandler.js");
const { httpError } = require("./utils/functions.js");

const corsOptions = {origin: [process.env.ORIGIN], credentials: true}
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use("/v1/auth", authRouter);
app.use("/v1/protected", protectedRouter);
app.use("/v1/users", usersRouter);
app.use("/v1/routes", routesRouter);
app.use("/v1/attendance", attendanceRouter);
app.get("/test", (req, res, next) => {
    try {
        throw httpError(500, "Internal");
    } catch(e) {
        next(e);
    }
})
app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || 'Internal Server error' });
});

socketHandler(server);

const PORT = Number(process.env.PORT);
server.listen(PORT, () => {
    console.log("Server is listening to Port: " + PORT);
})