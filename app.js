require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const cookieParser = require('cookie-parser');

const corsOptions = {origin: [process.env.ORIGIN], credentials: true}
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

app.get("/v1/auth", (req, res) => {
    res.json({message: "Test worked :)"})
});

const PORT = Number(process.env.PORT);
app.listen(PORT, () => {
    console.log("Server is listening to Port: " + PORT);
})