const db = require("../storage/routesQuery.js");
const axios = require("axios");
const { httpError, schoolScope, scopedSchoolFilter } = require("../utils/functions.js");
const { assertRouteInScope, assertUserInScope } = require("../storage/scopeQuery.js");
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
        const { name } = req.body;
        //A school account's new routes land at its own school whatever the body
        //says. For an admin the body is the answer, as before.
        const schoolid = schoolScope(req.user) ?? req.body.schoolid;
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
        const schoolid = scopedSchoolFilter(req.user, readIdFilter(req.query.schoolid, "school"));

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
        const rows = await db.getRouteOptions(schoolScope(req.user));
        res.json({routes: rows});
    } catch(err) {
        console.log("Server Error (getRouteOptions): " + err);
        next(err);
    }
}

//next(err) rather than a flat 500, here and in the handlers below: the scope
//guard answers 404 and that has to reach the browser as a 404.
exports.getRouteWaypoints = async (req, res, next) => {
    try {
        const routeid = req.params.id;
        await assertRouteInScope(req.user, routeid);

        const rows = await db.getWaypointsByRoute(routeid);
        const data = rows.waypoints[0];
        if (!data.route_exists) {
            return res.status(400).json({ message: "No route with this id" });
        }
        if (data.waypoints.length === 0) {
            return res.status(404).json({ message: "No waypoints found", driver: rows.driver[0] });
        }

        res.json({waypoints: data.waypoints, driver: rows.driver[0]});
    } catch(err) {
        console.log("Server Error (getRouteWaypoints): " + err);
        next(err);
    }
}

exports.saveDraft = async (req, res, next) => {
    const routeid = req.params.id;
    const { inserts, updates, deletes } = req.body;
    try{
        await assertRouteInScope(req.user, routeid);

        const rows = await db.saveDraftChanges(routeid, inserts, updates, deletes);
        if(rows.length === 0) {
            return res.json({message: "Done!", waypoints: []});
        }

        res.json({message: "Done!", waypoints: rows});
    } catch(err) {
        console.log("Server Error (saveDraft): " + err);
        next(err);
    }
}

//One Mapbox driving route through the given "lng,lat;lng,lat;..." stops, in
//the order they are listed.
async function fetchDirections(coordinates) {
    const response = await axios.get(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`, {
        params: {
            geometries: "geojson",
            overview: "full",
            access_token: process.env.SECRET_TOKEN,
        }
    });
    return response.data;
}

//The same stops, last first. Each "lng,lat" pair is kept intact - only their
//order is turned round.
const reverseCoordinates = (coordinates) => coordinates.split(";").reverse().join(";");

/*
    A run as updateRoutes stores it: the line Mapbox drew and where each stop
    sits along it. `stops` must be in the order this run visits them.
*/
function buildRun(directions, stops) {
    const result = directions.routes[0];
    return {
        route: {
            geometry: result.geometry,
            duration: result.duration,
            distance: result.distance
        },
        stops: buildWaypointGeometry(stops, directions)
    };
}

/*
    Generates both runs of a route, or sends back the stored pair.

    The afternoon is asked for separately, with the stops in reverse, rather
    than being the morning line read backwards. The way home is not the way
    there run in reverse: one-way streets, turn restrictions and divided roads
    mean school -> first stop is often a different road from first stop ->
    school, and a mirrored line sends the bus the wrong way down them - with
    every ETA a parent sees measured along a road the bus is not on.

    The afternoon's coordinates are the morning's turned round, not re-read
    from the database, so the two runs are guaranteed to describe the same
    stops - whatever the client sent - in opposite orders.
*/
exports.getRoutes = async (req, res, next) => {
    try {
        const { routeid, coordinates } = req.body;
        if(!routeid || !coordinates) {
           return res.status(400).json({message: "Insuffecient Data"});
        }
        //Guarded before the Mapbox call, not after: generating directions for
        //another school's route would spend a billed request on it either way.
        await assertRouteInScope(req.user, routeid);

        const routeWithDistance = await db.getRouteWithDistance(routeid);
        if(routeWithDistance[0].has_distance) {
            return res.json({routes: routeWithDistance[0]});
        }

        //Two billed requests where there used to be one. They only happen here,
        //after a route's stops change, never per run or per ping.
        const [morningDirections, afternoonDirections] = await Promise.all([
            fetchDirections(coordinates),
            fetchDirections(reverseCoordinates(coordinates))
        ]);

        //Read back in sort_number order, the same order the coordinates above
        //were built in, so a leg and a stop line up by index - and reversed for
        //the afternoon, which is the order that run visits them in.
        const stops = await db.getWaypointsInOrder(routeid);
        const morning = buildRun(morningDirections, stops);
        const afternoon = buildRun(afternoonDirections, [...stops].reverse());

        const rows = await db.updateRoutes(routeid, morning, afternoon);
        if(rows.length === 0) {
            return res.status(404).json({message: "No routes found"});
        }

        res.json({routes: rows[0]});
    } catch(err) {
        console.log("Server Error (getRoutes): " + err);
        next(err);
    }
}

exports.searchStudent = async (req, res, next) => {
    try{
        const searchedName = req.params.name;
        //Scoped in the query so the LIMIT counts only students this caller may
        //attach to a stop - filtering the result would silently return fewer.
        const rows = await db.searchStudentName(searchedName, schoolScope(req.user));
        if(rows.length === 0) {
            return res.status(404).json({message: "No student found"});
        }

        res.json({students: rows});
    } catch(err) {
        console.log("Server Error (searchStudent): " + err);
        next(err);
    }
}

exports.deleteRoute = async (req, res, next) => {
    const routeid = req.params.id;
    try{
        await assertRouteInScope(req.user, routeid);

        await db.deleteRouteById(routeid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (deleteRoute): " + err);
        next(err);
    }
}

exports.searchDriver = async (req, res, next) => {
    try{
        const searchedName = req.params.name;
        const rows = await db.searchDriverName(searchedName, schoolScope(req.user));
        if(rows.length === 0) {
            return res.status(404).json({message: "No driver found"});
        }

        res.json({drivers: rows});
    } catch(err) {
        console.log("Server Error (searchDriver): " + err);
        next(err);
    }
}

exports.updateRoutesDriver = async (req, res, next) => {
    try{
        const { userid, routeid } = req.body;
        //Both halves: the route must be theirs, and so must the driver. Without
        //the second, a school account could attach any driver in the system -
        //including one it is not allowed to see - to its own route.
        await assertRouteInScope(req.user, routeid);
        await assertUserInScope(req.user, userid);

        await db.updateDriver(userid, routeid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateRoutesDriver): " + err);
        next(err);
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
        
        await assertRouteInScope(req.user, routeid);

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
        const {name} = req.body;
        const routeid = Number(req.params.routeid);
        if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');
        if(!name) throw httpError(400, "Name must be provided");

        await assertRouteInScope(req.user, routeid);

        /*
            A school account cannot move a route to another school - that is the
            one edit here that would take the route out of its own scope, or
            reach into somebody else's. Its own school is forced; an admin still
            sets it from the body and still has to provide one.
        */
        const schoolid = schoolScope(req.user) ?? req.body.schoolid;
        if(!schoolid) throw httpError(400, "School name/id must be provided");
        const cleanName = name.trim();

        await db.updateRouteData(cleanName, schoolid, routeid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateRoutesData): " + err);
        next(err);
    }
}