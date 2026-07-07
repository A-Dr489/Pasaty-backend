const { Router } = require("express");
const protectedRouter = Router();
const protectedController = require('../controller/protectedController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

protectedRouter.get("/profile", authenticateUser, protectedController.getProfile);
protectedRouter.get("/students", authenticateUser, requiredRole(ROLE.PARENT), protectedController.getStudents);
protectedRouter.get("/myroutes", authenticateUser, requiredRole(ROLE.DRIVER), protectedController.getMyRoutes);
protectedRouter.get("/attendance/:studentid", authenticateUser, requiredRole(ROLE.PARENT), protectedController.getStudentAttendance);

module.exports = protectedRouter;