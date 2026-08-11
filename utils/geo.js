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
    belongs to two different stations. `fromStation` settles it: only the
    stretch between fromStation - backward and fromStation + forward is
    searched, so progress already made is never handed back. `backward` exists
    because a GPS fix can land a few metres behind the previous one without the
    bus having actually reversed.
*/
function snapToLine(coordinates, point, options = {}) {
    if(!Array.isArray(coordinates) || coordinates.length < 2) return null;

    const { fromStation = null, backward = 0, forward = Infinity } = options;
    const cumulative = cumulativeDistances(coordinates);

    const lowest = fromStation === null ? -Infinity : fromStation - backward;
    const highest = fromStation === null ? Infinity : fromStation + forward;

    let best = null;

    for(let i = 0; i < coordinates.length - 1; i++) {
        const segmentStart = cumulative[i];
        const segmentEnd = cumulative[i + 1];

        //Whole segments outside the window are never candidates.
        if(segmentEnd < lowest || segmentStart > highest) continue;

        const { fraction, offset } = projectOnSegment(point, coordinates[i], coordinates[i + 1]);

        if(best === null || offset < best.offset) {
            best = {
                station: segmentStart + (segmentEnd - segmentStart) * fraction,
                offset: offset,
                index: i,
                total: cumulative[cumulative.length - 1]
            };
        }
    }

    /*
        Nothing fell inside the window. Better to report a position measured
        against the whole line, with an offset the caller can judge, than to
        report no position at all.
    */
    if(best === null && fromStation !== null) {
        return snapToLine(coordinates, point, {});
    }

    return best;
}

module.exports = {
    haversine,
    cumulativeDistances,
    lineLength,
    snapToLine
}
