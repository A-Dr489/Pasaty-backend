const db = require("../storage/routesQuery.js");
const axios = require("axios");
const { httpError } = require("../utils/functions.js");
const { readPage, buildPage, readIdFilter } = require("../utils/pagination.js");
const { snapToLine } = require("../utils/geo.js");

/*
    Works out where every stop sits on the line Mapbox just returned.

    Stations come from snapping each stop onto the geometry rather than from
    adding up the leg distances, because snapping is the same measurement the
    bus will be judged by later and the two have to agree. Each stop is
    searched forward of the one before it, so a route that retraces itself
    cannot place a later stop at an earlier station.
*/
function buildWaypointGeometry(stops, directions) {
    const route = directions.routes[0];
    const coordinates = route.geometry?.coordinates ?? [];
    const legs = Array.isArray(route.legs) ? route.legs : [];
    //Where Mapbox pulled each coordinate we sent onto the road network.
    const snappedInputs = Array.isArray(directions.waypoints) ? directions.waypoints : [];

    /*
        If the client sent a different number of coordinates than the route has
        stored stops, index i in the response is not stop i and nothing from
        Mapbox can be trusted positionally. Stations still come out right
        because they are snapped from the stop's own coordinates.
    */
    const legsAligned = legs.length === stops.length - 1;
    const inputsAligned = snappedInputs.length === stops.length;
    if(!legsAligned || !inputsAligned) {
        console.log(`getRoutes: ${legs.length} legs and ${snappedInputs.length} inputs for ${stops.length} stops, falling back to stored coordinates`);
    }

    let previousStation = null;

    return stops.map((stop, index) => {
        const snapped = inputsAligned ? snappedInputs[index]?.location : null;
        const point = snapped ? snapped : [stop.longitude, stop.latitude];

        const hit = snapToLine(coordinates, point, {
            fromStation: previousStation === null ? 0 : previousStation
        });
        const station = hit ? hit.station : null;

        //Taken from the gap between two stations so it can never disagree
        //with the stations themselves.
        const legDistance = (station === null || previousStation === null)
            ? null
            : station - previousStation;

        let legDuration = null;
        if(index > 0) {
            if(legsAligned) {
                legDuration = legs[index - 1].duration;
            } else if(legDistance !== null && route.distance > 0) {
                //Counts did not line up, so share the total time out by distance.
                legDuration = route.duration * (legDistance / route.distance);
            }
        }

        if(station !== null) previousStation = station;

        return {
            id: stop.id,
            station: station,
            leg_distance: legDistance,
            leg_duration: legDuration
        };
    });
}



//in the create route path in the admin portal
exports.postRoute = async (req, res) => {
    try {
        const { name, schoolid } = req.body;
        const rows = await db.addRouteName(name, schoolid);
        if(rows.length === 0) {
            return res.status(404).json({message: "Something went wrong when getting the route"});
        }

        res.json({routeid: rows[0].id});
    } catch(e) {
        console.log("Server Error (postRoute): " + e);
        if(e.code === '23505') {
            res.status(400).json({message: "Name must be Unique"});
        } else {
            res.status(500).json({message: "Internal Server Error"});
        }
    }
}

//One page of routes. See usersController.getAllUsers for why the search and
//the school filter share an endpoint and why an empty page is a 200.
exports.getAllRoutes = async (req, res, next) => {
    try{
        const { limit, cursor } = readPage(req.query);
        const search = (req.query.search ?? '').trim();
        const schoolid = readIdFilter(req.query.schoolid, "school");

        const filters = { search: search, schoolid: schoolid };

        const rows = await db.getRoutesPage({...filters, cursor: cursor, limit: limit});
        const page = buildPage(rows, limit);
        const total = cursor === null ? await db.countRoutes(filters) : undefined;

        res.json({
            routes: page.items,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            total: total
        });
    } catch(err) {
        console.log("Server Error (getAllRoutes): " + err);
        next(err);
    }
}

//The whole route list, id and name only, to fill the route dropdown on the
//students page. Not paged on purpose - see getRouteOptions in the query file.
exports.getRouteOptions = async (req, res, next) => {
    try{
        const rows = await db.getRouteOptions();
        res.json({routes: rows});
    } catch(err) {
        console.log("Server Error (getRouteOptions): " + err);
        next(err);
    }
}

exports.getRouteWaypoints = async (req, res) => {
    try {
        const routeid = req.params.id;
        const rows = await db.getWaypointsByRoute(routeid);
        const data = rows.waypoints[0];
        if (!data.route_exists) {
            return res.status(400).json({ message: "No route with this id" });
        }
        if (data.waypoints.length === 0) {
            return res.status(404).json({ message: "No waypoints found", driver: rows.driver[0] });
        }

        res.json({waypoints: data.waypoints, driver: rows.driver[0]});
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
        if(!routeid || !coordinates) {
           return res.status(400).json({message: "Insuffecient Data"});
        }
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

        //Read back in sort_number order, the same order the coordinates above
        //were built in, so a leg and a stop line up by index.
        const stops = await db.getWaypointsInOrder(routeid);
        const waypointGeometry = buildWaypointGeometry(stops, response.data);

        const rows = await db.updateRoutes(routeid, route, waypointGeometry);
        if(rows.length === 0) {
            return res.status(404).json({message: "No routes found"});
        }

        res.json({routes: rows[0]});
    } catch(e) {
        console.log("Server Error (getRoutes): " + e);
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

exports.deleteRoute = async (req, res) => {
    const routeid = req.params.id;
    try{
        await db.deleteRouteById(routeid);

        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (deleteRoute): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.searchDriver = async (req, res) => {
    try{
        const searchedName = req.params.name;
        const rows = await db.searchDriverName(searchedName);
        if(rows.length === 0) {
            return res.status(404).json({message: "No driver found"});
        }

        res.json({drivers: rows});
    } catch(e) {
        console.log("Server Error (searchDriver): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.updateRoutesDriver = async (req, res) => {
    try{
        const { userid, routeid } = req.body;
        await db.updateDriver(userid, routeid);

        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (updateRoutesDriver): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getDriverRoute = async (req, res, next) => {
    try{
        const routeid = Number(req.params.routeid);
        if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');

        const { routeData, waypoints } = await db.getDriverRoute(routeid, req.user.userid);

        res.json({route: routeData[0], waypoints: waypoints});
    } catch(err) {
        console.log("Server Error (getDriverRoute): " + err);
        next(err);
    }
}

exports.getRouteById = async (req, res, next) => {
    try{
        const routeid = Number(req.params.routeid);
        if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');
        
        const rows = await db.getRouteById(routeid);
        if(rows.length === 0) throw httpError(404, "No route found");

        res.json({route: rows[0]})
    } catch(err) {
        console.log("Server Error (getRouteById): " + err);
        next(err);
    }
}

exports.updateRoutesData = async (req, res, next) => {
    try{
        const {name, schoolid} = req.body;
        const routeid = Number(req.params.routeid);
        if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');
        if(!name) throw httpError(400, "Name must be provided");
        if(!schoolid) throw httpError(400, "School name/id must be provided");
        const cleanName = name.trim();

        await db.updateRouteData(cleanName, schoolid, routeid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateRoutesData): " + err);
        next(err);
    }
}