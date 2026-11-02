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
    Told: the drawn line, every stop's coordinates, the bus position and the
    time it was taken, and their own child's countdown.

    Not told: anybody's name, any other child's studentid or arrival time, the
    driver's identity, speed, heading or accuracy, and the internal station and
    snap offset. Every payload here is built by listing the fields that go in,
    never by removing fields from a database row - a row gains columns, and a
    blocklist forwards the next one silently.
*/

const db = require("../storage/busQuery.js");
const users = require("../storage/usersQuery.js");
const { httpError } = require("../utils/functions.js");
const { PHASE, ROUTE_STATUS } = require("../utils/enum.js");
const { estimateFromStoredLocation } = require("../utils/busProgress.js");
const { afternoonOrder } = require("../utils/stopOrder.js");

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
    The line to DRAW, which is not the line the bus is measured against.

    runGeometry builds an afternoon ruler by joining the morning line to the
    afternoon one, because the driver starts the afternoon at home and drives
    to the school before collecting anybody. That is the right ruler and the
    wrong picture: the journey the children are on is the afternoon line alone,
    school to door. So this picks the stored line for the phase and nothing is
    concatenated.
*/
function lineFor(route, phase) {
    if(phase === PHASE.AFTERNOON && route.afternoon_geo?.coordinates?.length) {
        return route.afternoon_geo;
    }
    return route.geo ?? null;
}

/*
    The stops, in the order the run visits them, as coordinates and a flag.

    studentid decides `mine` and is then dropped: a parent gets the shape of
    the route and their own place in it, and no way to tell which pin belongs
    to which family.
*/
function stopsFor(rows, phase, studentid) {
    const ordered = phase === PHASE.AFTERNOON
        ? afternoonOrder(rows)
        : [...rows].sort((a, b) => Number(a.sort_number) - Number(b.sort_number));

    return ordered.map((stop) => ({
        longitude: stop.longitude,
        latitude: stop.latitude,
        mine: stop.studentid !== null && Number(stop.studentid) === Number(studentid)
    }));
}

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
        const run = runInProgress(route);
        //Outside a run there is nothing live to report. The driver is off the
        //clock and the server does not even store where they are.
        const phase = run ? run.phase : PHASE.MORNING;

        const stopRows = await db.getStopsForMap(route.id);

        const location = run === null ? null : ((await users.getDriverLocation(route.id))[0] ?? null);
        const estimate = location === null
            ? null
            : await estimateFromStoredLocation(
                route, location,
                () => users.getStopsForEta(route.id),
                Date.now()
            );

        res.json({
            run: run,
            route: {
                id: route.id,
                name: route.name,
                updatedat: route.updatedat,
                geo: lineFor(route, phase)
            },
            stops: stopsFor(stopRows, phase, studentid),
            bus: busFor(location),
            mine: run === null ? null : mineFor(estimate, route, phase, studentid)
        });
    } catch(err) {
        console.log("Server Error (getChildBus): " + err);
        next(err);
    }
}
