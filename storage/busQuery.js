const pool = require("./pool.js");

const SCHOOL_TZ = process.env.SCHOOL_TZ;

/*
    One child's route, for that child's parent.

    OWNERSHIP IS IN THE WHERE CLAUSE, not in a check around it. `s.parentid =
    $3` is what makes a request for somebody else's child return no rows, and
    the controller turns no rows into a 404 - the same shape
    getAttendanceByStudentId uses in protectedQuery.js. A guard written as a
    separate read can be forgotten at the next call site; this one cannot.

    IS THE RUN TODAY'S?
    -------------------
    routes.morning_status says what the LAST morning run did, with no date
    attached. Production currently holds four runs left IN_PROGRESS and never
    completed, one of them sixteen days old - so trusting the status alone
    would show a parent a bus position from a fortnight ago as if it were
    moving now. The two _is_today flags are the same guard AttendanceQuery
    applies before letting a driver resume a run, and the controller requires
    them before it reports a run at all.

    Everything runGeometry needs is here (geo, afternoon_geo, the distances and
    durations, and the two started_at columns), so the estimate can be rebuilt
    from one read.

    THE TWO GEO COLUMNS ARE STILL NEEDED EVEN THOUGH THEY ARE NO LONGER SENT.
    The response stopped carrying the route line - see the note at the top of
    busController.js - but the line is still what the bus is measured against:
    runGeometry snaps the stored position onto it to work out how far the bus
    is from each waiting child. Dropping `geo` here because "the line is gone
    from the payload" would leave every parent with a position and no countdown,
    and nothing would error. `updatedat` is gone because it dated the line for
    caching, and there is no longer a line to date.
*/
async function getChildRoute(studentid, parentid) {
    const { rows } = await pool.query(`
        SELECT r.id, r.name,
               r.geo, r.distance, r.duration,
               r.afternoon_geo, r.afternoon_distance, r.afternoon_duration,
               r.morning_status, r.afternoon_status,
               r.morning_started_at, r.afternoon_started_at,
               (COALESCE(r.morning_completed_at, r.morning_started_at) AT TIME ZONE $2)::date
                 = (now() AT TIME ZONE $2)::date AS morning_is_today,
               (COALESCE(r.afternoon_completed_at, r.afternoon_started_at) AT TIME ZONE $2)::date
                 = (now() AT TIME ZONE $2)::date AS afternoon_is_today,
               s.id   AS studentid,
               a.morning_status   AS student_morning_status,
               a.afternoon_status AS student_afternoon_status
          FROM students s
          JOIN routes r ON r.id = s.routeid
          LEFT JOIN attendance a
                 ON a.studentid = s.id
                AND a.routeid = s.routeid
                AND a.attendance_date = (now() AT TIME ZONE $2)::date
         WHERE s.id = $1
           AND s.parentid = $3
    `, [studentid, SCHOOL_TZ, parentid]);
    return rows;
}

/*
    The two pins a parent's map draws: the school, and this child's own door.

    THIS USED TO RETURN EVERY STOP ON THE ROUTE, and that is worth recording as
    a mistake rather than quietly deleting. The coordinates were sent without
    names, which is what made it look acceptable - but a list of every stop on a
    route, in driving order, IS the home address of every family on that bus,
    and the app it was sent to only ever drew two of them. Leaving a field out
    of the display protects nobody. Leaving it out of the response does.

    So: at most two rows, and a parent is entitled to both. The school is shared
    by everyone on the route, and the other belongs to the child whose id the
    caller already had to know - and own, see getChildRoute - to get this far.

    THE FLAGS ARE COMPUTED HERE so that the controller never holds `type` or
    `studentid` for these rows and therefore cannot forward either by accident.
    It is the same trick as morning_is_today above: let SQL answer the question
    instead of handing out the raw column and asking everyone to be careful.
    `type = 'school'` is a literal because waypoints.type has no enum on the
    server - see the note at the top of utils/stopOrder.js, which spells out the
    same two type names for the same reason.

    Either row can be missing, and neither absence is an error:
      * a route with no school waypoint - route 108 has none;
      * a child whose stop was deleted from the route while students.routeid
        still points at it.
    The controller sends null for a missing pin and the app draws one less.

    IS NOT DISTINCT FROM, not `=`, for the is_mine flag: the school row's
    studentid is null, and `null = $2` is null rather than false, which would
    hand the controller a three-valued boolean to reason about. This returns a
    real true/false for every row.
*/
async function getMapPins(routeid, studentid) {
    const { rows } = await pool.query(`
        SELECT longitude, latitude,
               type = 'school' AS is_school,
               studentid IS NOT DISTINCT FROM $2 AS is_mine
          FROM waypoints
         WHERE routeid = $1
           AND (type = 'school' OR studentid = $2)
         ORDER BY sort_number
    `, [routeid, studentid]);
    return rows;
}

module.exports = {
    getChildRoute,
    getMapPins
}
