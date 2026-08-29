const { Router } = require("express");
const authRouter = Router();
const authController = require("../controller/authController.js");
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { PORTAL_ROLES } = require("../utils/enum.js");
const { loginByAccount, loginByAddress, refresh } = require("../utils/rateLimit.js");

//No limiter on register: it is admin-only now, so there is nothing to guess at.
authRouter.post("/register", authenticateUser, requiredRole(...PORTAL_ROLES), authController.postRegister);
//Two limiters, and both must pass: one guards the account being attacked, the
//other the host doing the attacking. See utils/rateLimit.js for the reasoning.
authRouter.post("/login", loginByAccount, loginByAddress, authController.postLogin);
authRouter.post("/refresh", refresh, authController.postRefresh);
//Logout is not limited: it carries no secret to guess, and it succeeds either
//way - so a limiter that only counts failures would never count anything.
authRouter.post("/logout", authController.postLogout);

module.exports = authRouter;