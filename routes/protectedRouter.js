const { Router } = require("express");
const protectedRouter = Router();
const protectedController = require('../controller/protectedController.js');
const absenceController = require('../controller/absenceController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

protectedRouter.get("/profile", authenticateUser, protectedController.getProfile);
protectedRouter.get("/myroutes", authenticateUser, requiredRole(ROLE.DRIVER), protectedController.getMyRoutes);

protectedRouter.get("/students", authenticateUser, requiredRole(ROLE.PARENT), protectedController.getStudents);
protectedRouter.get("/attendance/:studentid", authenticateUser, requiredRole(ROLE.PARENT), protectedController.getStudentAttendance);

/*
    Planned absence - a parent taking their child off a morning run, either
    right now or days ahead. Morning only by design; see absenceController.

    Listed above the bare "/" delete so the two are read together, and nobody
    later reads DELETE /absence as the account deletion below it.
*/
protectedRouter.post("/absence", authenticateUser, requiredRole(ROLE.PARENT), absenceController.declareAbsence);
protectedRouter.delete("/absence", authenticateUser, requiredRole(ROLE.PARENT), absenceController.cancelAbsence);
protectedRouter.get("/absence", authenticateUser, requiredRole(ROLE.PARENT), absenceController.listAbsences);

protectedRouter.delete("/", authenticateUser, protectedController.deleteAccount);

module.exports = protectedRouter;