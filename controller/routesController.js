const db = require("../storage/routesQuery.js");
const axios = require("axios");

//in the create route path in the admin portal
exports.postRoute = async (req, res) => {
    const { name } = req.body;
    try {
        const rows = await db.addRouteName(name);
        if(rows.length === 0) {
            return res.status(404).json({message: "Something went wrong when getting the route"});
        }

        res.json({routeid: rows[0].id});
    } catch(e) {
        console.log("Server Error (postRoute): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getAllRoutes = async (req, res) => {
    try{
        const rows = await db.getAllRoutes();
        if(rows.length === 0) {
            return res.status(404).json({message: "No routes founded"});
        }

        res.json({routes: rows});
    } catch(e) {
        console.log("Server Error (getAllRoutes): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getRouteWaypoints = async (req, res) => {
    const routeid = req.params.id;
    try {
        const rows = await db.getWaypointsByRoute(routeid);
        const data = rows[0];
        if (!data.route_exists) {
            return res.status(400).json({ message: "No route with this id" });
        }
        if (data.waypoints.length === 0) {
            return res.status(404).json({ message: "No waypoints found" });
        }

        res.json({waypoints: data.waypoints});
    } catch(e) {
        console.log("Server Error (getRouteWaypoints): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.saveDraft = async (req, res) => {
    const routeid = req.params.id;
    const { inserts, updates, deletes } = req.body;
    try{
        const rows = await db.saveDraftChanges(routeid, inserts, updates, deletes);
        if(rows.length === 0) {
            return res.json({message: "Done!", waypoints: []});
        }

        res.json({message: "Done!", waypoints: rows});
    } catch(e) {
        console.log("Server Error (saveDraft): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

//It will check if it needs to create a route or send the original one
exports.getRoutes = async (req, res) => {
    try {
        const { routeid, coordinates } = req.body;
        const routeWithDistance = await db.getRouteWithDistance(routeid);
        if(routeWithDistance[0].has_distance) {
            return res.json({routes: routeWithDistance[0]});
        }
        const response = await axios.get(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`, {
            params: {
                geometries: "geojson",
                overview: "full",
                access_token: process.env.SECRET_TOKEN,
            }
        });

        const result = response.data.routes[0];
        const route = {
            geometry: result.geometry,
            duration: result.duration,
            distance: result.distance
        }
        const rows = await db.updateRoutes(routeid, route);
        if(rows.length === 0) {
            return res.status(404).json({message: "No routes found"});
        }

        res.json({routes: rows[0]});
    } catch(e) {
        console.log("Server Error (getRoutes): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.searchRoute = async (req, res) => {
    try{
        const { search } = req.body;
        if (!search || search.trim() === '') {
            return res.status(400).json({ message: "The search was empty!" });
        }
        const name = search.trim();
        const rows = await db.searchRouteName(name);

        if(rows.length === 0) {
            return res.status(404).json({message: "No routes found"});
        }

        res.json({routes: rows});
    } catch(e) {
        console.log("Server Error (searchRoute): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.searchStudent = async (req, res) => {
    try{
        const searchedName = req.params.name;
        const rows = await db.searchStudentName(searchedName);
        if(rows.length === 0) {
            return res.status(404).json({message: "No student found"});
        }

        res.json({students: rows});
    } catch(e) {
        console.log("Server Error (searchStudent): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}