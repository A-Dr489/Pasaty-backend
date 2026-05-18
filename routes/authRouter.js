const { Router } = require("express");
const authRouter = Router();
const authController = require("../controller/authController.js");

authRouter.post("/register", authController.postRegister);
authRouter.post("/login", authController.postLogin);
authRouter.post("/refresh", authController.postRefresh);
authRouter.post("/logout", authController.postLogout);

module.exports = authRouter;