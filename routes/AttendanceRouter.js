const { Router } = require("express");
const attendanceRouter = Router();
const attendanceController = require("../controller/AttendanceController.js");
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

attendanceRouter.post("/:routeid/morning/start", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.startMorning);
attendanceRouter.post("/:attendanceid/morning/board", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.boardMorningStudent);
attendanceRouter.post("/:attendanceid/morning/absent", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.absentMorningStudent); //NEW
attendanceRouter.post("/:routeid/morning/complete", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.completeMorning);

attendanceRouter.post("/:routeid/afternoon/start", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.startAfternoon);
attendanceRouter.post("/:attendanceid/afternoon/board", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.boardAfternoonStudent);
attendanceRouter.post("/:attendanceid/afternoon/absent", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.absentAfternoonStudent); //NEW
attendanceRouter.patch("/:attendanceid/afternoon/dropoff", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.dropoffAfternoonStudent);
attendanceRouter.post("/:routeid/afternoon/complete", authenticateUser, requiredRole(ROLE.DRIVER), attendanceController.completeAfternoon);

//Ahead of the "/:attendanceid" patterns, so "student" is never read as an id.
attendanceRouter.get("/student/:studentid", authenticateUser, requiredRole(ROLE.ADMIN), attendanceController.studentAttendance);
attendanceRouter.get("/student/:studentid/export", authenticateUser, requiredRole(ROLE.ADMIN), attendanceController.studentAttendanceExport);
attendanceRouter.get("/school/:schoolid", authenticateUser, requiredRole(ROLE.ADMIN), attendanceController.schoolAttendance);
attendanceRouter.get("/school/:schoolid/export", authenticateUser, requiredRole(ROLE.ADMIN), attendanceController.schoolAttendanceExport);

attendanceRouter.patch("/:attendanceid", authenticateUser, requiredRole(ROLE.ADMIN), attendanceController.adminOverride);
attendanceRouter.post("/:routeid/attendance", authenticateUser, requiredRole(ROLE.ADMIN, ROLE.DRIVER), attendanceController.routeAttendance);
//MVP
attendanceRouter.put("/restart/:routeid", authenticateUser, requiredRole(ROLE.ADMIN, ROLE.DRIVER, ROLE.DRIVER), attendanceController.restartTrip);

module.exports = attendanceRouter;