require("dotenv").config();
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require('cookie-parser');
const authRouter = require("./routes/authRouter.js");
const protectedRouter = require("./routes/protectedRouter.js");
const usersRouter = require("./routes/usersRouter.js");
const routesRouter = require("./routes/routesRouter.js");
const attendanceRouter = require("./routes/AttendanceRouter.js");
const dataRouter = require("./routes/dataRouter.js");
const deviceRouter = require("./routes/deviceRouter.js");
const { socketHandler } = require("./sockets/socketHandler.js");
const { httpError } = require("./utils/functions.js");
const pool = require("./storage/pool.js");
//[process.env.ORIGIN]
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || origin == process.env.ORIGIN) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }, 
    credentials: true
}
/*
    Railway terminates TLS and forwards over plain HTTP, so without this Express
    believes every connection is insecure and that every caller is the proxy.
    That second part is what matters: the rate limiters key on req.ip, and one
    shared key would mean the whole world sharing one budget.

    1, not true: it trusts exactly one hop - Railway's own proxy. `true` trusts
    the entire chain, which lets a caller put whatever they like in
    X-Forwarded-For and hand themselves a fresh rate-limit budget per request.
*/
app.set("trust proxy", 1);

/*
    Security headers. Most of what helmet does is aimed at pages - CSP,
    clickjacking - and means little for an API that only ever answers JSON. The
    parts that earn their place here are HSTS, which stops a browser ever
    retrying this domain over plain HTTP, nosniff, and dropping the
    X-Powered-By: Express header that currently announces the stack.

    crossOriginResourcePolicy has to be widened from helmet's same-origin
    default: the client is served from another origin entirely, and the xlsx
    exports are fetched cross-origin from it.
*/
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use("/v1/auth", authRouter);
app.use("/v1/protected", protectedRouter);
app.use("/v1/users", usersRouter);
app.use("/v1/data", dataRouter);
app.use("/v1/routes", routesRouter);
app.use("/v1/attendance", attendanceRouter);
app.use("/v1/devices", deviceRouter);
app.get("/test", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT 1 FROM users");
        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (test): " + e);
        res.status(500).json({message: "Internal Server Error"})
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