const { Router } = require("express");
const routesRouter = Router();
const routesController = require('../controller/routesController.js');
const { authenticateUser, requiredRole } = require("../utils/authMiddleware.js");
const { ROLE, PORTAL_ROLES } = require("../utils/enum.js");

routesRouter.post("/init", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.postRoute);
routesRouter.get('/', authenticateUser, requiredRole(...PORTAL_ROLES), routesController.getAllRoutes);
routesRouter.get("/waypoints/:id", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.getRouteWaypoints);
routesRouter.post("/waypoints/:id", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.saveDraft);
routesRouter.put("/generation", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.getRoutes);
//Ahead of "/:routeid", which would otherwise swallow "options" as an id.
routesRouter.get("/options", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.getRouteOptions);
routesRouter.get("/search/student/:name", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.searchStudent);
routesRouter.delete("/:id", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.deleteRoute);
routesRouter.get("/search/driver/:name", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.searchDriver);
routesRouter.put("/driver", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.updateRoutesDriver);
routesRouter.get("/driver/route/:routeid", authenticateUser, requiredRole(ROLE.DRIVER), routesController.getDriverRoute);
routesRouter.get("/:routeid", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.getRouteById);
routesRouter.put("/:routeid", authenticateUser, requiredRole(...PORTAL_ROLES), routesController.updateRoutesData);

module.exports = routesRouter;