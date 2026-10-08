/*
    Route geometry helpers.

    Every point here is a GeoJSON coordinate pair: [longitude, latitude], the
    same order Mapbox returns and the same order routes.geo is stored in.
    Passing [latitude, longitude] does not throw, it just returns wrong
    answers, so the order is spelled out on every function below.
*/

const EARTH_RADIUS_M = 6371000;

const toRadians = (degrees) => degrees * Math.PI / 180;

//Great-circle distance in metres between two [lng, lat] points.
function haversine(a, b) {
    const deltaLat = toRadians(b[1] - a[1]);
    const deltaLng = toRadians(b[0] - a[0]);

    const h = Math.sin(deltaLat / 2) ** 2
        + Math.cos(toRadians(a[1])) * Math.cos(toRadians(b[1])) * Math.sin(deltaLng / 2) ** 2;

    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/*
    How far along the line each vertex sits. cumulative[i] is the distance from
    the start of the line to vertex i, so the last entry is the whole length.
*/
function cumulativeDistances(coordinates) {
    const cumulative = [0];
    for(let i = 1; i < coordinates.length; i++) {
        cumulative[i] = cumulative[i - 1] + haversine(coordinates[i - 1], coordinates[i]);
    }
    return cumulative;
}

function lineLength(coordinates) {
    if(!Array.isArray(coordinates) || coordinates.length < 2) return 0;
    const cumulative = cumulativeDistances(coordinates);
    return cumulative[cumulative.length - 1];
}

/*
    Drops a point onto the segment a -> b.

    Returns how far along the segment the closest point sits as a 0..1
    fraction, plus how far the point was from the segment in metres.

    Both ends are converted into a flat metre grid centred on the segment
    first. Over a stretch of road this short the curvature error is far below
    GPS noise, and it keeps the projection to plain 2D algebra.
*/
function projectOnSegment(point, a, b) {
    const latitudeReference = toRadians((a[1] + b[1]) / 2);

    const toMetres = (p) => [
        toRadians(p[0] - a[0]) * Math.cos(latitudeReference) * EARTH_RADIUS_M,
        toRadians(p[1] - a[1]) * EARTH_RADIUS_M
    ];

    const [pointX, pointY] = toMetres(point);
    const [endX, endY] = toMetres(b);

    const segmentLengthSquared = endX * endX + endY * endY;

    //A zero length segment (a duplicated vertex) has nothing to project onto.
    const fraction = segmentLengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, (pointX * endX + pointY * endY) / segmentLengthSquared));

    const offsetX = pointX - endX * fraction;
    const offsetY = pointY - endY * fraction;

    return {
        fraction: fraction,
        offset: Math.sqrt(offsetX * offsetX + offsetY * offsetY)
    };
}

/*
    Finds where a point sits on the line.

    Returns { station, offset, index, total }: station is metres from the start
    of the line, offset is how far the point was from the line, index is the
    segment it landed on, and total is the length of the whole line. Returns
    null when there is no line to snap to.

    A route can retrace or cross itself, and then one set of coordinates
    belongs to two different stations. There are two ways to settle that, and
    which one applies depends on whether anything is known about where the bus
    was a moment ago.

    `fromStation` is the one for when something is: only the stretch between
    fromStation - backward and fromStation + forward is searched, so progress
    already made is never handed back. `backward` exists because a GPS fix can
    land a few metres behind the previous one without the bus having actually
    reversed.

    `preferEarliest` is the one for when nothing is - the first fix of a run.
    Among the places the point could be, the earliest whose offset is within
    that many metres of the closest is taken. It applies only when there is no
    `fromStation`, because the two settle the same question and a window has
    already answered it: inside one, preferring the earliest would simply drag
    every fix back towards the window's near edge. Passing both is normal, and
    means "search here, and if that search has to fall back to the whole line,
    break the tie this way". The afternoon leaves from the
    driver's own doorstep and comes back to it, so that one spot is both
    station 0 and the final station, and the two answers are equally close to
    within a metre: whichever won decided whether the run read as about to
    begin or as already finished. It has to be a tolerance rather than a flat
    preference for earlier, because a bus whose first fix arrives late - a
    kilometre into the run, on a route that passed nearby earlier - must still
    be placed where it actually is. Measured on the real routes, the two ends
    of a run differ by 0 m while two different roads differ by at least 62, so
    a tolerance the size of ordinary GPS jitter separates them.
*/
function snapToLine(coordinates, point, options = {}) {
    if(!Array.isArray(coordinates) || coordinates.length < 2) return null;

    const { fromStation = null, backward = 0, forward = Infinity, preferEarliest = 0 } = options;
    const cumulative = cumulativeDistances(coordinates);

    const lowest = fromStation === null ? -Infinity : fromStation - backward;
    const highest = fromStation === null ? Infinity : fromStation + forward;

    let best = null;
    //Collected in station order, so the first match below is the earliest.
    const candidates = preferEarliest > 0 && fromStation === null ? [] : null;

    for(let i = 0; i < coordinates.length - 1; i++) {
        const segmentStart = cumulative[i];
        const segmentEnd = cumulative[i + 1];

        //Whole segments outside the window are never candidates.
        if(segmentEnd < lowest || segmentStart > highest) continue;

        const { fraction, offset } = projectOnSegment(point, coordinates[i], coordinates[i + 1]);

        const hit = {
            station: segmentStart + (segmentEnd - segmentStart) * fraction,
            offset: offset,
            index: i,
            total: cumulative[cumulative.length - 1]
        };

        if(candidates !== null) candidates.push(hit);
        if(best === null || offset < best.offset) best = hit;
    }

    /*
        Nothing fell inside the window. Better to report a position measured
        against the whole line, with an offset the caller can judge, than to
        report no position at all.
    */
    if(best === null && fromStation !== null) {
        return snapToLine(coordinates, point, { preferEarliest: preferEarliest });
    }

    if(candidates !== null && best !== null) {
        const limit = best.offset + preferEarliest;
        const earliest = candidates.find((candidate) => candidate.offset <= limit);
        if(earliest) return earliest;
    }

    return best;
}

module.exports = {
    haversine,
    cumulativeDistances,
    lineLength,
    snapToLine
}
