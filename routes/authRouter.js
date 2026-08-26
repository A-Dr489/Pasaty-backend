const { Router } = require("express");
const authRouter = Router();
const authController = require("../controller/authController.js");
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

authRouter.post("/register", authenticateUser, requiredRole(ROLE.ADMIN), authController.postRegister);
authRouter.post("/login", authController.postLogin);
authRouter.post("/refresh", authController.postRefresh);
authRouter.post("/logout", authController.postLogout);

module.exports = authRouter;