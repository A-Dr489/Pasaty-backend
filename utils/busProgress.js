/*
    Where the bus is on its route, and who it is still coming for.

    Two ways in, and they have to agree:

      estimateRoute              - a ping has just arrived from the driver.
      estimateFromStoredLocation - somebody opened a page and the last ping
                                   was minutes ago.

    Both place a fix on the run's line, both express every stop as a station on
    that same line, and both end in buildEstimate. The only difference is what
    they have to narrow the search with: a ping has the previous ping, a page
    load has only the station stored beside the position.

    Lifted out of controller/usersController.js unchanged, because the parent
    live map needs the second one too and a second copy of this reasoning is
    the last thing it should get.

    NOTHING HERE READS THE DATABASE, like utils/eta.js and utils/geo.js beside
    it. The stops are fetched by a function the caller passes in - and passed as
    a function rather than an array so that a run which turns out to have no
    line to measure against still makes no query at all, which is what the
    controller did before the move.
*/

const { PHASE } = require("./enum.js");
const { snapToLine } = require("./geo.js");
const { buildEstimate, runGeometry } = require("./eta.js");

//A fix can land a few metres behind the last one without the bus reversing.
const GPS_JITTER_M = 40;
//Fast enough that no bus outruns the search window, slow enough that the
//window still means something after a long silence.
const MAX_PLAUSIBLE_SPEED_MS = 30;
const MIN_FORWARD_WINDOW_M = 200;
//Further off the line than any GPS error explains: the window, not the bus,
//is in the wrong place.
const OFF_LINE_M = 150;

/*
    Where a fix sits on the line, searched the way the caller's options say.

    A windowed snap can only answer with a point inside its window, so a window
    built on a station that does not belong to this line puts the bus wherever
    the window happens to reach and keeps it there: the next ping carries that
    same wrong station forward, and the run never recovers. Regenerating a
    route mid-run does exactly that - every station is rewritten, and the row
    from five seconds ago describes a line that no longer exists.

    So a fix further from the window's stretch of road than any GPS error
    explains is measured against the whole line instead, and that answer is
    taken only when it is dramatically better. An ordinary route that doubles
    back on itself is nowhere near this threshold and keeps its window.

    Both the live path and the one that rebuilds an estimate for a page load go
    through here, so the two cannot answer differently for the same position.
*/
function placeOnLine(line, point, search) {
    let hit = snapToLine(line, point, search);
    if(!hit) return null;

    if(hit.offset > OFF_LINE_M) {
        //Same tie-break as the caller asked for, or the rescue could land the
        //bus at the end of a run it is only just starting.
        const unwindowed = snapToLine(line, point, { preferEarliest: search.preferEarliest ?? 0 });
        if(unwindowed && unwindowed.offset < hit.offset / 4) hit = unwindowed;
    }

    return hit;
}

/*
    Places the bus on the route line and works out who it is still coming for.

    Which line that is - the morning's, the afternoon's own, or for a route not
    yet regenerated the morning's read backwards - is runGeometry's decision in
    utils/eta.js. Every station it hands back means the same thing in both
    phases, distance covered since this run began, so nothing below branches on
    direction.

    `loadStops` is called at most once, and only once there is something to
    measure: () => db.getStopsForEta(route.id).
*/
async function estimateRoute(route, phase, location, previous, loadStops, now) {
    const { line, stationOf, plannedPace } = runGeometry(route, phase);
    if(line.length < 2) return null;

    const startedAt = phase === PHASE.AFTERNOON ? route.afternoon_started_at : route.morning_started_at;

    /*
        Only carry progress forward within THIS RUN.

        driver_location keeps one row per route and overwrites it for ever, so
        the row waiting at the first ping of today's run is whatever the last
        ping of some earlier run left behind. Matching on the phase alone was
        not enough to tell those apart: 'morning' === 'morning' is as true of
        yesterday's run as of this one.

        What that cost is the whole bug. A morning starting after a day with no
        afternoon run carried yesterday morning's final station - the END of
        the line - and the window below then searched only the last forty
        metres of the route. The bus sitting at the depot was placed two
        kilometres away at the far end, every stop read as already passed, and
        Stops ahead stayed empty for the entire run while the marker moved
        along the map quite normally. Restarting a trip did a quieter version
        of the same thing: the bus jumped a kilometre ahead and the stops it
        had "passed" disappeared one by one.

        It only ever bit when two runs of the same phase followed each other,
        which is why it came and went: in a day that runs both morning and
        afternoon the phases alternate and the old row is always the other one.

        updated_at, not recorded_at: both it and started_at are written by the
        database's own clock, so the comparison cannot be thrown by a driver's
        phone being a few minutes out.
    */
    const sameRun = previous
        && previous.phase === phase
        && previous.station !== null
        && startedAt
        && new Date(previous.updated_at).getTime() >= new Date(startedAt).getTime();

    const carried = sameRun ? Number(previous.station) : null;

    const secondsSincePrevious = previous
        ? (location.recorded_at.getTime() - new Date(previous.recorded_at).getTime()) / 1000
        : null;

    /*
        A run with nothing to carry has no window to search in, so the whole
        line is measured - and then the tie is broken towards the start.

        That matters for the afternoon, which leaves from the driver's own
        start and comes back to it: that one place is both station 0 and the
        last station on the line, and the two answers are the same distance
        from the fix to within a metre. Landing on the far one read the run as
        finished before it had begun - every stop behind the bus, so Stops
        ahead stayed empty for the whole afternoon while the marker drove along
        quite normally. Which way the coin fell depended on where in the yard
        the bus was parked, which is why it came and went.

        A tolerance rather than a flat preference for the earlier station: a
        driver whose first fix arrives late, already a kilometre into the run,
        is still placed where they actually are. See snapToLine.
    */
    const hit = placeOnLine(line, [location.longitude, location.latitude], carried === null
        ? { preferEarliest: GPS_JITTER_M }
        : {
            fromStation: carried,
            backward: GPS_JITTER_M,
            /*
                Widens with the gap since the last fix. A phone that lost
                signal for five minutes comes back far down the road, and a
                fixed window would refuse to believe it had moved.
            */
            forward: Math.max(
                MIN_FORWARD_WINDOW_M,
                (secondsSincePrevious ?? 0) * MAX_PLAUSIBLE_SPEED_MS + MIN_FORWARD_WINDOW_M
            )
        });
    if(!hit) return null;

    //Each stop re-expressed as a station on this run's line. One with no place
    //on it was added since the route was last generated, and is left out.
    const stops = (await loadStops())
        .map((stop) => ({ ...stop, station: stationOf(stop) }))
        .filter((stop) => stop.station !== null);

    const estimate = buildEstimate({
        routeid: route.id,
        phase: phase,
        busStation: hit.station,
        stops: stops,
        plannedPace: plannedPace,
        elapsedSeconds: startedAt ? (now - new Date(startedAt).getTime()) / 1000 : null,
        snapOffset: hit.offset,
        now: now
    });

    /*
        `stops` comes back as well as the estimate, and only for one reason:
        the estimate names children by studentid alone - deliberately, so that
        the broadcast to the staff room says nothing about families - while the
        family feed has to reach the right parent. These rows carry parentid,
        and handing them back costs nothing where a second getStopsForEta per
        ping would cost a round trip.
    */
    return { station: hit.station, offset: hit.offset, estimate: estimate, stops: stops };
}

/*
    The same estimate, rebuilt from the position already stored.

    handleDriverLocation is the only thing that produces one, and it only runs
    when a ping arrives. A page opened between pings therefore had nothing to
    show and sat on "waiting for the next position report" for as long as that
    took - which, if the driver's phone is locked or out of signal, is the whole
    run. The bus marker was there the entire time, because that comes from the
    stored row; only the stops and their times were missing.

    The coordinates are snapped again rather than the stored station being
    reused, and that is not belt and braces: the station stored with a position
    was measured against whatever line the route had AT THE TIME, and a route
    regenerated since - every one of them, when the afternoon stopped being the
    morning line reversed - leaves that number describing a line that no longer
    exists. Route 1's stored afternoon station was 2040 m along a 2.1 km
    mirrored line; its real afternoon line is 1.3 km, so every stop read as
    already passed and the board came back empty. Re-snapping makes this answer
    the same one a ping at that spot produces, which is the point of it.

    The search is narrowed by the station stored with the position - the live
    path's own answer for this very fix - so the two paths agree about a place
    the line passes twice. The afternoon's start and its finish are the same
    patch of road, and an unwindowed search there picks whichever is a metre
    nearer: a page opened at the start of an afternoon would have shown an
    empty board while the driver's own app showed five stops. A station left
    over from a line that has since been regenerated falls outside the window
    and is corrected, which is what the paragraph above is about.

    null when there is nothing to measure against: no stored position, or no
    geometry to measure it against.
*/
async function estimateFromStoredLocation(route, location, loadStops, now) {
    if(!location) return null;

    const longitude = Number(location.longitude);
    const latitude = Number(location.latitude);
    if(!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

    const phase = location.phase === PHASE.AFTERNOON ? PHASE.AFTERNOON : PHASE.MORNING;
    const { line, stationOf, plannedPace } = runGeometry(route, phase);
    if(line.length < 2) return null;

    const stored = location.station === null || location.station === undefined
        ? null
        : Number(location.station);

    const hit = placeOnLine(line, [longitude, latitude], stored === null
        //Recorded while the route had no geometry, so there is no progress to
        //search from and this is the first-fix case.
        ? { preferEarliest: GPS_JITTER_M }
        : {
            fromStation: stored,
            backward: GPS_JITTER_M,
            forward: MIN_FORWARD_WINDOW_M,
            //Carried for the two ways this search can end up measuring the
            //whole line anyway: a station that falls outside it entirely, and
            //placeOnLine's off-line rescue.
            preferEarliest: GPS_JITTER_M
        });
    if(!hit) return null;

    const stops = (await loadStops())
        .map((stop) => ({ ...stop, station: stationOf(stop) }))
        .filter((stop) => stop.station !== null);

    const startedAt = phase === PHASE.AFTERNOON ? route.afternoon_started_at : route.morning_started_at;

    return buildEstimate({
        routeid: route.id,
        phase: phase,
        busStation: hit.station,
        stops: stops,
        plannedPace: plannedPace,
        elapsedSeconds: startedAt ? (now - new Date(startedAt).getTime()) / 1000 : null,
        snapOffset: hit.offset,
        now: now
    });
}

module.exports = {
    GPS_JITTER_M,
    MAX_PLAUSIBLE_SPEED_MS,
    MIN_FORWARD_WINDOW_M,
    OFF_LINE_M,
    placeOnLine,
    estimateRoute,
    estimateFromStoredLocation
}
