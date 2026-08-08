const { Router } = require("express");
const dataRouter = Router();
const dataController = require('../controller/dataController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

dataRouter.post("/school", authenticateUser, requiredRole(ROLE.ADMIN), dataController.createSchool);
dataRouter.get("/school/:name", authenticateUser, requiredRole(ROLE.ADMIN), dataController.searchSchool);
dataRouter.get("/schools", authenticateUser, requiredRole(ROLE.ADMIN), dataController.getAllSchools);
dataRouter.put("/school/:schoolid", authenticateUser, requiredRole(ROLE.ADMIN), dataController.updateSchool);

dataRouter.post("/overview", authenticateUser, requiredRole(ROLE.ADMIN), dataController.getOverview);
dataRouter.post("/overview/routes", authenticateUser, requiredRole(ROLE.ADMIN), dataController.getRouteBoard);
dataRouter.post("/overview/attendance", authenticateUser, requiredRole(ROLE.ADMIN), dataController.getAttendanceTrend);

module.exports = dataRouter;