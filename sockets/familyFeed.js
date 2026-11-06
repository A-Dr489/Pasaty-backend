/*
    What a parent is told while the bus is running.

    WHY THIS IS NOT JUST THE ROUTE ROOM
    -----------------------------------
    `route:<id>` is the staff and driver room, and it is thick with other
    people's business: every attendance broadcast sends the whole roster, each
    row carrying a child's first_name and their parent_name; `eta:updated`
    carries every child's studentid and arrival time; `bus:location` carries
    the driver's speed, heading, accuracy and snap offset.

    canAccessRoute used to let a parent into that room on the strength of
    having a child on the route, which would have handed one family the lot.
    So parents have rooms of their own:

        route:<id>:family            every parent on the route - the bus
        route:<id>:family:<parentid> one parent          - their own child

    Two rooms because socket.io sends one payload to a room and the countdown
    differs per family, while the bus position is the same for everybody. The
    split is the privacy mechanism: a parent is not in a room that carries
    another child's name, so nothing here depends on remembering to strip a
    field before sending.

    WHAT IS IN THE PAYLOADS, AND WHAT IS NOT
    ----------------------------------------
    family:bus  the position and when it was taken. Not the driver's id, not
                their speed, not their heading, not the accuracy, not the
                station or the snap offset. A parent needs to see the bus
                moving; a number they can screenshot as evidence of how fast
                their driver was going is a liability and not a feature.

    family:eta  their own child, by a studentid they already know, with the
                arrival numbers and how many stops the bus reaches first.
                `stops_ahead` is the context a parent actually wants - "three
                stops before yours" - and it names nobody.

    family:run  a run started or finished, so the map can open and close
                itself instead of polling to find out.
*/

const { SOCKET_EVENT } = require("../utils/enum.js");

const familyRoom = (routeid) => `route:${routeid}:family`;
const parentRoom = (routeid, parentid) => `route:${routeid}:family:${parentid}`;

/*
    The bus, as a parent may see it.

    Written as an explicit list of fields rather than by deleting the ones we
    do not want from the stored row. driver_location has gained columns before
    - station, phase and snap_offset were all added after it was first written
    - and a blocklist silently forwards the next one. This way a new column
    reaches a parent only when somebody adds it here on purpose.
*/
const busForFamily = (location) => ({
    routeid: location.routeid,
    latitude: location.latitude,
    longitude: location.longitude,
    phase: location.phase,
    recorded_at: location.recorded_at
});

/*
    Everything one ping has to say to the families on a route.

    `stops` are the rows the estimate was built from, which carry parentid;
    `estimate.stops` are the arrival numbers, already ordered nearest-first by
    stopEtas. The two are matched on studentid rather than by position, because
    the estimate drops children who are no longer waiting and the lists are
    therefore different lengths.

    A child with no parent on record, or whose parent is not connected, costs
    one emit into an empty room - socket.io discards it without serialising.
*/
function emitToFamilies(io, routeid, location, estimate, stops) {
    io.to(familyRoom(routeid)).emit(SOCKET_EVENT.FAMILY_BUS, busForFamily(location));

    if(!estimate || !Array.isArray(estimate.stops)) return;

    const parentOf = new Map();
    for(const stop of (stops ?? [])) {
        if(stop.studentid !== null && stop.parentid !== null && stop.parentid !== undefined) {
            parentOf.set(Number(stop.studentid), stop.parentid);
        }
    }

    estimate.stops.forEach((stop, index) => {
        const parentid = parentOf.get(Number(stop.studentid));
        if(parentid === undefined) return;

        io.to(parentRoom(routeid, parentid)).emit(SOCKET_EVENT.FAMILY_ETA, {
            routeid: routeid,
            phase: estimate.phase,
            studentid: stop.studentid,
            generated_at: estimate.generated_at,
            confidence: estimate.confidence,
            //How many still-waiting stops the bus reaches before this one.
            stops_ahead: index,
            meters_away: stop.meters_away,
            seconds_away: stop.seconds_away,
            eta: stop.eta
        });
    });
}

/*
    One child's status changed, told to that child's family alone.

    Parents were previously in the route room, where attendance:updated goes -
    along with every other child's name. They are not any more, so without this
    an open map would show "WAITING" long after the child was dropped off, and
    the only word of it would be a push notification the parent may have
    dismissed.

    `at` is when the status was set, so the app can show "dropped off 13:42"
    rather than just a changed label. No name: the parent knows their own
    child's, and the studentid tells them which one when they have two.
*/
function emitStudentToFamily(io, routeid, parentid, { studentid, phase, status, at }) {
    if(parentid === null || parentid === undefined) return;

    io.to(parentRoom(routeid, parentid)).emit(SOCKET_EVENT.FAMILY_STUDENT, {
        routeid: routeid,
        phase: phase,
        studentid: studentid,
        status: status,
        at: at ?? null
    });
}

/*
    The register for this route is no longer what you think - read it again.

    Sent to the staff room and to the families, because a restart deletes the
    attendance rows outright and every attendanceid a client holds dies with
    them. There is no per-row update that can describe that.
*/
function emitReload(io, routeid, reason) {
    const payload = { routeid: routeid, reason: reason };
    io.to(`route:${routeid}`).emit(SOCKET_EVENT.ROUTE_RELOAD, payload);
    io.to(familyRoom(routeid)).emit(SOCKET_EVENT.ROUTE_RELOAD, payload);
}

//A run has started or finished. Three fields, so a map can open and close.
function emitRunToFamilies(io, routeid, phase, status, at) {
    io.to(familyRoom(routeid)).emit(SOCKET_EVENT.FAMILY_RUN, {
        routeid: routeid,
        phase: phase,
        status: status,
        at: at ?? null
    });
}

module.exports = {
    familyRoom,
    parentRoom,
    busForFamily,
    emitToFamilies,
    emitRunToFamilies,
    emitStudentToFamily,
    emitReload
}
