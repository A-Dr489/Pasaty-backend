const { Router } = require("express");
const dataRouter = Router();
const dataController = require('../controller/dataController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { PORTAL_ROLES } = require("../utils/enum.js");

dataRouter.post("/school", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.createSchool);
dataRouter.get("/school/:name", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.searchSchool);
dataRouter.get("/schools", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.getAllSchools);
dataRouter.put("/school/:schoolid", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.updateSchool);

dataRouter.post("/overview", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.getOverview);
dataRouter.post("/overview/routes", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.getRouteBoard);
dataRouter.post("/overview/attendance", authenticateUser, requiredRole(...PORTAL_ROLES), dataController.getAttendanceTrend);

module.exports = dataRouter;