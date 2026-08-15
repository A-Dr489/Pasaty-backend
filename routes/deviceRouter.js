const { Router } = require("express");
const deviceRouter = Router();
const deviceController = require('../controller/deviceController.js');
const { authenticateUser } = require("../utils/authMiddleware.js");

//No requiredRole: a parent needs pushes, and a driver may want them later.
//Which events reach whom is decided when they are sent, not here.
deviceRouter.post("/", authenticateUser, deviceController.registerDevice);
deviceRouter.delete("/", authenticateUser, deviceController.unregisterDevice);

module.exports = deviceRouter;