const { Router } = require("express");
const usersRouter = Router();
const usersController = require('../controller/usersController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { PORTAL_ROLES } = require("../utils/enum.js");

usersRouter.get("/", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.getAllUsers);
usersRouter.get("/students/:id", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.getStudentFromParent);
usersRouter.put("/:id", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.updateUser);
usersRouter.delete("/student/:id", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.deleteStudent);
usersRouter.delete("/user/:id", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.deleteUser);
usersRouter.get("/students", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.getStudents);
usersRouter.put("/student/:studentid", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.updateStudent);
usersRouter.get("/parent/:name", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.searchParent);
usersRouter.put("/student/parent/:studentid", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.updateStudentParent)
usersRouter.get("/location/:routeid", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.getBusLocation);
usersRouter.get("/tokens/:id", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.getUserTokens);
usersRouter.delete("/tokens/:id/:tokenid", authenticateUser, requiredRole(...PORTAL_ROLES), usersController.revokeUserToken);

module.exports = usersRouter;