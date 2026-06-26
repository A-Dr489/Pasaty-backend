const { Router } = require("express");
const routesRouter = Router();
const routesController = require('../controller/routesController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE } = require("../utils/enum.js");

routesRouter.post("/init", authenticateUser, requiredRole(ROLE.ADMIN), routesController.postRoute);
routesRouter.get('/', authenticateUser, requiredRole(ROLE.ADMIN), routesController.getAllRoutes);
routesRouter.get("/waypoints/:id", authenticateUser, requiredRole(ROLE.ADMIN), routesController.getRouteWaypoints);
routesRouter.post("/waypoints/:id", authenticateUser, requiredRole(ROLE.ADMIN), routesController.saveDraft);
routesRouter.put("/generation", authenticateUser, requiredRole(ROLE.ADMIN), routesController.getRoutes);
routesRouter.post("/search", authenticateUser, requiredRole(ROLE.ADMIN), routesController.searchRoute);
routesRouter.get("/search/student/:name", authenticateUser, requiredRole(ROLE.ADMIN), routesController.searchStudent);
routesRouter.delete("/:id", authenticateUser, requiredRole(ROLE.ADMIN), routesController.deleteRoute);

module.exports = routesRouter;