/*
    The order a route's stops are driven in, per run, and the coordinate list
    that goes with it.

    The morning is sort_number ascending - the order the admin numbered them in,
    start -> students -> school - and every query that needs it says so in SQL.
    This file is about the other one.

    THE AFTERNOON IS NOT THE MORNING BACKWARDS
    ------------------------------------------
    It used to be: the afternoon drove the same stops in reverse, and that is
    all afternoon_station ever measured. But the order children are picked up in
    is not the order it makes sense to drop them off in - traffic at four
    o'clock is not traffic at seven, a child whose parent is not home until half
    past is better left till last, and one-way streets make some reversals a
    detour rather than a mirror. So a stop now carries a second number,
    waypoints.afternoon_sort_number, and that is the order the afternoon drives.

    A ROUTE WITH NO AFTERNOON ORDER KEEPS THE OLD BEHAVIOUR
    -------------------------------------------------------
    The column is nullable and every row that existed before it was added is
    null. `afternoonOrder` falls back to the morning order reversed for those,
    which is exactly what their afternoons did before - so a route nobody has
    opened since is never worse off than it was, and the fallback is the same
    one the stored geometry was measured with.

    The fallback is all-or-nothing per route, not per stop. A half-numbered
    route has no order worth trusting: mixing the two rules would interleave
    stops by two different measures and produce a sequence neither the admin nor
    the generated line ever asked for. The editor always writes a complete set,
    so a partial route only exists where something else put it there.

    THE ENDS ARE PINNED
    -------------------
    The school is always first in the afternoon order and the depot - the
    driver's own door, waypoint type `start` - always last. Only the children in
    between are free to move.

    That is not a style rule, it is what keeps arrival times honest. The server
    measures an afternoon run along the morning line followed by the afternoon
    line, joined at the school, because the bus starts the afternoon at the
    driver's house and drives to the school before collecting anybody (see
    runGeometry in utils/eta.js). The join only holds if the afternoon line
    begins where the morning line ends. Put a child's stop first and that ruler
    jumps the width of the city at its very first metre, and every arrival time
    for the rest of the run is measured from the wrong place.

    Pinning is applied on the way out, not just trusted from the stored numbers,
    so a hand-edited row cannot break the join either.
*/

//Waypoint types, as `waypoints.type` stores them. The server has no enum for
//these - the two that matter here are the two ends of a run.
const SCHOOL = "school";
const DEPOT = "start";

//Where each stop belongs in the afternoon: the school's band, the children's,
//or the depot's.
const BAND = { [SCHOOL]: 0, [DEPOT]: 2 };
const bandOf = (waypoint) => BAND[waypoint?.type] ?? 1;

/*
    A stop's afternoon number, or null when it has none.

    Numeric columns arrive from postgres as strings, so it goes through Number()
    - and `Number(null)` is 0, not NaN, which would read a missing number as
    "first in the afternoon" and quietly reorder the whole run. The null check
    comes first for exactly that reason.
*/
function afternoonNumberOf(waypoint) {
    const raw = waypoint?.afternoon_sort_number;
    if(raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

//True only when every stop carries an afternoon number - see all-or-nothing
//above. An empty route has no order to speak of, so it is false.
function hasAfternoonOrder(waypoints) {
    return Array.isArray(waypoints)
        && waypoints.length > 0
        && waypoints.every((waypoint) => afternoonNumberOf(waypoint) !== null);
}

/*
    The stops in the order the afternoon drives them.

    Returns a new array - the caller's is left alone - and the stops themselves
    are the same objects, so whatever else they carry rides along.

    Two passes, and the second relies on sort being stable (guaranteed since
    ES2019): the first puts the stops in their own order, the second moves the
    school to the front and the depot to the back without disturbing anything
    inside those bands.
*/
function afternoonOrder(waypoints) {
    if(!Array.isArray(waypoints)) return [];

    const ordered = hasAfternoonOrder(waypoints)
        ? [...waypoints].sort((a, b) => afternoonNumberOf(a) - afternoonNumberOf(b))
        : [...waypoints].sort((a, b) => Number(b.sort_number) - Number(a.sort_number));

    return ordered.sort((a, b) => bandOf(a) - bandOf(b));
}

//The same stops, last first. Each "lng,lat" pair is kept intact - only their
//order is turned round.
const reverseCoordinates = (coordinates) => coordinates.split(";").reverse().join(";");

//A stop list as Mapbox wants it: "lng,lat;lng,lat;...".
const coordinatesOf = (stops) =>
    stops.map((stop) => `${stop.longitude},${stop.latitude}`).join(";");

/*
    The afternoon's coordinates, and the stops they describe in the same order.

    The two have to agree. Mapbox answers positionally - leg i is between stop i
    and stop i+1, and waypoints[i] is where it pulled stop i onto the road - so
    a list in one order paired with stops in another assigns every station to
    the wrong child.

    Three ways to arrive at the pair, in order of preference:

    1. The editor sent an afternoon order. It is the only party that knows about
       stops that have been dragged but not yet saved, so its list wins - paired
       with the stored stops put through the same rule.

    2. Nothing was sent, but the route has an afternoon order stored. That is a
       portal build older than the column talking to this server, and reversing
       the morning would quietly drive an order the admin did not choose. The
       stored stops' own coordinates are used instead.

    3. Neither: the morning turned round, which is what every afternoon was
       before any of this existed.

    A sent list describing a different number of stops is not used at all. It
    cannot be reconciled with the stops on record, and guessing which of the two
    is stale is how you generate a route through the wrong houses.
*/
function afternoonRunOf(stops, coordinates, sent) {
    const expected = coordinates.split(";").length;

    if(typeof sent === "string" && sent.length > 0) {
        if(sent.split(";").length === expected) {
            const ordered = afternoonOrder(stops);
            /*
                The list sent and the stored stops describe the same places in
                the same sequence almost always - the editor applies this same
                rule to the rows it loaded. When they differ, something on
                screen has been dragged or renumbered and not saved: the list
                is still the one driven, because it is what the admin is
                looking at, but the stations are measured against the stored
                rows and only a save can reconcile the two.

                Logged because the symptom - one child's arrival time attached
                to another child's house - is otherwise almost impossible to
                trace back to here. NOT logged merely because a route has no
                afternoon order of its own: both sides then derive the morning
                reversed and agree about it perfectly.
            */
            if(sent !== coordinatesOf(ordered)) {
                console.log("getRoutes: afternoon_coordinates does not match the stored stops - the draft was not saved before generating");
            }
            return { coordinates: sent, stops: ordered };
        }
        console.log(`getRoutes: afternoon_coordinates describes ${sent.split(";").length} stops, not ${expected} - ignoring it`);
    }

    if(hasAfternoonOrder(stops)) {
        const ordered = afternoonOrder(stops);
        return { coordinates: coordinatesOf(ordered), stops: ordered };
    }

    return { coordinates: reverseCoordinates(coordinates), stops: [...stops].reverse() };
}

module.exports = {
    afternoonNumberOf,
    hasAfternoonOrder,
    afternoonOrder,
    reverseCoordinates,
    afternoonRunOf
}
