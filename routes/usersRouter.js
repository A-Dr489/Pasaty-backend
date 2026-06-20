const { Router } = require("express");
const usersRouter = Router();
const usersController = require('../controller/usersController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

usersRouter.get("/", authenticateUser, requiredRole(ROLE.ADMIN), usersController.getAllUsers);
usersRouter.get("/students/:id", authenticateUser, requiredRole(ROLE.ADMIN), usersController.getStudentFromParent);
usersRouter.put("/:id", authenticateUser, requiredRole(ROLE.ADMIN), usersController.updateUser);
usersRouter.delete("/student/:id", authenticateUser, requiredRole(ROLE.ADMIN), usersController.deleteStudent);
usersRouter.delete("/user/:id", authenticateUser, requiredRole(ROLE.ADMIN), usersController.deleteUser);

module.exports = usersRouter;