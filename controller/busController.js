/*
    The parent live map, as one snapshot.

    A parent opening the map needs the whole picture at once - the line, the
    stops, where the bus is and when it reaches their child - and then the
    socket keeps only the moving parts up to date (sockets/familyFeed.js). This
    is the "at once" half, and it exists for the same reason the admin page has
    getBusLocation: the server speaks only when the driver pings, so a map
    opened between pings would otherwise sit empty for up to a ping's worth of
    time, or for the whole run if the driver's phone is locked.

    WHAT A PARENT IS AND IS NOT TOLD
    --------------------------------
    Told: where the bus is and when that position was taken, where the school
    is, where their own child waits, and their own child's countdown.

    Not told: anybody's name, any other child's studentid or arrival time, the
    driver's identity, speed, heading or accuracy, the internal station and snap
    offset - and no route line and no list of stops.

    THE LINE AND THE STOP LIST WERE TAKEN OUT ON PURPOSE. DO NOT PUT THEM BACK.
    The first version of this endpoint sent route.geo and every stop on the
    route as bare coordinates in driving order. No names, which is why it looked
    like enough. It is not: that list is where every family on the bus lives,
    and the line runs past each of their doors. The app drew two pins out of all
    of it, so the rest went to every phone for nothing - and anyone reading the
    app's network traffic got the lot. The mobile side asked for this cut and
    they were right to. If some future screen genuinely needs the shape of the
    route, send the line; do not bring back the stops.

    Every payload here is built by listing the fields that go in, never by
    removing fields from a database row - a row gains columns, and a blocklist
    forwards the next one silently.
*/

const db = require("../storage/busQuery.js");
const users = require("../storage/usersQuery.js");
const { httpError } = require("../utils/functions.js");
const { PHASE, ROUTE_STATUS } = require("../utils/enum.js");
const { estimateFromStoredLocation } = require("../utils/busProgress.js");

/*
    Which run is being driven right now, or null.

    Both halves matter. IN_PROGRESS says a driver started a run and never
    completed it; _is_today says it was this morning rather than a fortnight
    ago. Production holds four runs left open, one sixteen days old, so without
    the date the parents on those routes would be shown a stale position for
    ever and told it was live.
*/
function runInProgress(route) {
    if(route.morning_status === ROUTE_STATUS.IN_PROGRESS && route.morning_is_today === true) {
        return { phase: PHASE.MORNING, status: route.morning_status, started_at: route.morning_started_at };
    }
    if(route.afternoon_status === ROUTE_STATUS.IN_PROGRESS && route.afternoon_is_today === true) {
        return { phase: PHASE.AFTERNOON, status: route.afternoon_status, started_at: route.afternoon_started_at };
    }
    return null;
}

/*
    A map pin: two numbers, and nothing that says whose it is.

    Both pins go through here rather than being spread inline, so there is one
    place that decides what a pin consists of. getMapPins hands back `is_school`
    and `is_mine` instead of `type` and `studentid` precisely so that this
    function has nothing else it could pass on.

    A missing pin is null, not an omitted key: the app checks the field, and a
    route with no school waypoint is ordinary data, not a fault.
*/
const pinFor = (waypoint) => (waypoint == null ? null : {
    latitude: waypoint.latitude,
    longitude: waypoint.longitude
});

//The bus, listed field by field - see the note at the top of this file.
const busFor = (location) => (location === null ? null : {
    latitude: location.latitude,
    longitude: location.longitude,
    phase: location.phase,
    recorded_at: location.recorded_at
});

/*
    This child's own line on the board.

    `status` is their attendance for the phase being driven, which is what the
    app shows once there is nothing left to count down to - a child who has
    boarded has no entry in the estimate, because the estimate only carries
    who the bus is still coming for.
*/
function mineFor(estimate, route, phase, studentid) {
    const status = phase === PHASE.AFTERNOON
        ? route.student_afternoon_status
        : route.student_morning_status;

    const stops = estimate?.stops ?? [];
    const index = stops.findIndex((stop) => Number(stop.studentid) === Number(studentid));
    const stop = index === -1 ? null : stops[index];

    return {
        studentid: Number(studentid),
        status: status ?? null,
        //How many still-waiting stops the bus reaches first. null when this
        //child is not one of them any more.
        stops_ahead: index === -1 ? null : index,
        meters_away: stop ? stop.meters_away : null,
        seconds_away: stop ? stop.seconds_away : null,
        eta: stop ? stop.eta : null,
        confidence: estimate ? estimate.confidence : null
    };
}

exports.getChildBus = async (req, res, next) => {
    try {
        const studentid = Number(req.params.studentid);
        if(!Number.isInteger(studentid)) throw httpError(400, "Invalid studentid");

        const rows = await db.getChildRoute(studentid, req.user.userid);
        /*
            404, never 403. A child of another parent and a child who does not
            exist have to be indistinguishable: answering "forbidden" for one
            and "not found" for the other confirms that the first one exists
            and is on a route.

            A child with no route lands here too - the query joins routes - and
            that is the right answer for this endpoint: there is no bus.
        */
        if(rows.length === 0) throw httpError(404, "No route found for this student");

        const route = rows[0];
        //Outside a run there is nothing live to report. The driver is off the
        //clock and the server does not even store where they are - so `run`,
        //`bus` and `mine` all come back null, while the two pins are sent
        //either way. They do not depend on a run, and they cost one small read.
        const run = runInProgress(route);

        const pins = await db.getMapPins(route.id, studentid);
        const school = pins.find((pin) => pin.is_school === true) ?? null;
        const home = pins.find((pin) => pin.is_mine === true) ?? null;

        const location = run === null ? null : ((await users.getDriverLocation(route.id))[0] ?? null);
        const estimate = location === null
            ? null
            : await estimateFromStoredLocation(
                route, location,
                () => users.getStopsForEta(route.id),
                Date.now()
            );

        /*
            `route.updatedat` is gone along with the line. It was there so a
            client could tell whether the geometry it had cached was still the
            current one; with no geometry in the response there is nothing left
            for it to date. `name` stays - the app parses it, and it says
            nothing about any family.
        */
        res.json({
            run: run,
            route: {
                id: route.id,
                name: route.name
            },
            bus: busFor(location),
            school: pinFor(school),
            home: pinFor(home),
            mine: run === null ? null : mineFor(estimate, route, run.phase, studentid)
        });
    } catch(err) {
        console.log("Server Error (getChildBus): " + err);
        next(err);
    }
}
