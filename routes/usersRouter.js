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
usersRouter.post("/search", authenticateUser, requiredRole(ROLE.ADMIN), usersController.searchUser);
usersRouter.get("/students", authenticateUser, requiredRole(ROLE.ADMIN), usersController.getStudents);
usersRouter.put("/student/:studentid", authenticateUser, requiredRole(ROLE.ADMIN), usersController.updateStudent);
usersRouter.post("/students/search", authenticateUser, requiredRole(ROLE.ADMIN), usersController.searchStudent);
usersRouter.get("/parent/:name", authenticateUser, requiredRole(ROLE.ADMIN), usersController.searchParent);
usersRouter.put("/student/parent/:studentid", authenticateUser, requiredRole(ROLE.ADMIN), usersController.updateStudentParent)

module.exports = usersRouter;