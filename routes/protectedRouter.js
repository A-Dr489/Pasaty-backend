const { Router } = require("express");
const protectedRouter = Router();
const protectedController = require('../controller/protectedController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

protectedRouter.get("/profile", authenticateUser, protectedController.getProfile);

module.exports = protectedRouter;