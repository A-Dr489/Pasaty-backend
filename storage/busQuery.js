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
*/
async function getChildRoute(studentid, parentid) {
    const { rows } = await pool.query(`
        SELECT r.id, r.name, r.updatedat,
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
    Every stop on the route, as a parent may see it: where it is, and whether
    it is theirs.

    studentid comes back so the controller can mark the parent's own stop and
    then drop it. Nothing else about the child is read - no name, no attendance
    - because nothing else can be shown. type and both sort numbers are here so
    the caller can put them in the order the run being driven visits them.
*/
async function getStopsForMap(routeid) {
    const { rows } = await pool.query(`
        SELECT longitude, latitude, type, studentid,
               sort_number, afternoon_sort_number
          FROM waypoints
         WHERE routeid = $1
         ORDER BY sort_number
    `, [routeid]);
    return rows;
}

module.exports = {
    getChildRoute,
    getStopsForMap
}
