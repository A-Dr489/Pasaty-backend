require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const cookieParser = require('cookie-parser');
const authRouter = require("./routes/authRouter.js");
const protectedRouter = require("./routes/protectedRouter.js");
const usersRouter = require("./routes/usersRouter.js");

const corsOptions = {origin: [process.env.ORIGIN], credentials: true}
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.use("/v1/auth", authRouter);
app.use("/v1/protected", protectedRouter);
app.use("/v1/users", usersRouter);
app.get("/test", (req, res) => {
    res.json({message: "Request Worked"});
})

const PORT = Number(process.env.PORT);
app.listen(PORT, () => {
    console.log("Server is listening to Port: " + PORT);
})