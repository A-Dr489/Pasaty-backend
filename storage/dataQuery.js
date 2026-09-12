const pool = require("./pool.js");

async function addSchool(name, supervisor, supervisor_phone, city) {
    const { rows } = await pool.query(`
        INSERT INTO school (name, supervisor, supervisor_phone, city)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
    `, [name, supervisor, supervisor_phone, city]);

    return rows.length === 0
}

/*
    scope is null for an admin or sub-admin and a school id for a school
    account. Both reads take it the same way: `$2 IS NULL OR id = $2` leaves the
    unscoped case exactly as it was and narrows the scoped one to a single row,
    without two versions of the statement to keep in step.
*/
async function searchSchoolByName(name, scope = null) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT id, name AS school_name
        FROM school
        WHERE name ILIKE $1
          AND ($2::int IS NULL OR id = $2)
        LIMIT 10;
    `, [cleanName, scope]);
    return rows;
}

async function getSchools(scope = null) {
    const { rows } = await pool.query(
        "SELECT * FROM school WHERE $1::int IS NULL OR id = $1",
        [scope]
    );
    return rows;
}

async function updateSchool(schoolid, name, supervisor, phone, city) {
    await pool.query(`
        UPDATE school 
        SET name = $2, supervisor = $3, supervisor_phone = $4, city = $5
        WHERE id = $1
    `, [schoolid, name, supervisor, phone, city]);
}

const TERMINAL = ['ARRIVED', 'DROPPED_OFF', 'ABSENT'];

const SCHOOL_TZ = process.env.SCHOOL_TZ;

/* ---------------------------------------------------------------------------
   WHEN A ROUTE'S STATUS ACTUALLY HAPPENED

   routes.morning_status and its two timestamps are current-state columns, not
   a log: they describe the last run of that route, whenever that was, and no
   query here may assume it was today.

   The timestamp is chosen by the status rather than coalesced, because
   startMorningRoute stamps started_at and leaves the previous run's
   completed_at exactly where it was. A route out on the road right now still
   carries yesterday's completion, so COALESCE(completed, started) would date
   this morning's run to yesterday afternoon. The status is what says which of
   the two columns is the live one.

   Written as a fragment taking the phase by name, and only ever called with
   the two literals below. The caller's phase still reaches postgres as a bound
   parameter, never as text.
--------------------------------------------------------------------------- */
const runAt = (phase) => `
    CASE r.${phase}_status
        WHEN 'COMPLETED'   THEN r.${phase}_completed_at
        WHEN 'IN_PROGRESS' THEN r.${phase}_started_at
        ELSE COALESCE(r.${phase}_completed_at, r.${phase}_started_at)
    END`;

//The status, but only when the run it describes belongs to the day being asked
//about. Anything older reads as NULL, which the fleet tally already counts as
//not started - which is what an idle route is, today.
const statusOn = (phase, date, tz) => `
    CASE WHEN (${runAt(phase)} AT TIME ZONE ${tz})::date = ${date}::date
         THEN r.${phase}_status
    END`;

/*
    scope is null for an admin or sub-admin and a school id for a school
    account. Every statement below takes it as a parameter and narrows on it the
    same way - `$n IS NULL OR ... = $n` - so the unscoped case runs exactly the
    query it always did and there is only one version of each to maintain.

    An attendance row reaches its school through its route, and a student
    through students.schoolid. The two agree because saveDraftChanges refuses a
    waypoint that would put a child on another school's route.
*/
async function getOverview(date, phase, scope = null) {
    const FLEET_SQL = `
    SELECT
        COUNT(*) FILTER (WHERE st IS NULL)::int         AS "notStarted",
        COUNT(*) FILTER (WHERE st = 'IN_PROGRESS')::int AS "inProgress",
        COUNT(*) FILTER (WHERE st = 'COMPLETED')::int   AS "completed",
        COUNT(*) FILTER (WHERE st = 'CANCELLED')::int   AS "cancelled"
    FROM (
        SELECT CASE WHEN $1 = 'morning'
                    THEN ${statusOn('morning', '$2', '$3')}
                    ELSE ${statusOn('afternoon', '$2', '$3')}
               END AS st
        FROM routes r
        WHERE $4::int IS NULL OR r.schoolid = $4
    ) r`;

    const TALLY_SQL = `
    SELECT
        COUNT(*)::int                                                AS "total",
        COUNT(*) FILTER (WHERE a.morning_status   = 'WAITING')::int     AS "mWaiting",
        COUNT(*) FILTER (WHERE a.morning_status   = 'BOARDED')::int     AS "mBoarded",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ARRIVED')::int     AS "mArrived",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ABSENT')::int      AS "mAbsent",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'WAITING')::int     AS "aWaiting",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'BOARDED')::int     AS "aBoarded",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'DROPPED_OFF')::int AS "aDropped",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT')::int      AS "aAbsent",
        ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE a.morning_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8                       AS "morningRate",
        ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8                       AS "afternoonRate"
    FROM attendance a
    JOIN routes r ON r.id = a.routeid
    WHERE a.attendance_date = $1
      AND ($2::int IS NULL OR r.schoolid = $2)`;

    const COUNTS_SQL = `
    SELECT
        (SELECT COUNT(*) FROM students
          WHERE $1::int IS NULL OR schoolid = $1)::int               AS "students",
        (SELECT COUNT(*) FROM routes
          WHERE $1::int IS NULL OR schoolid = $1)::int               AS "routes",
        /* Drivers and parents have no school of their own, so they are counted
           the way they are listed - see userFilters in usersQuery.js. The same
           three arms, including the routeless driver who belongs to nobody. */
        (SELECT COUNT(*) FROM users u
          WHERE u.role = 'driver'
            AND ($1::int IS NULL
                 OR EXISTS (SELECT 1 FROM routes r WHERE r.driverid = u.id AND r.schoolid = $1)
                 OR NOT EXISTS (SELECT 1 FROM routes r WHERE r.driverid = u.id)))::int AS "drivers",
        (SELECT COUNT(*) FROM users u
          WHERE u.role = 'parent'
            AND ($1::int IS NULL
                 OR EXISTS (SELECT 1 FROM students s WHERE s.parentid = u.id AND s.schoolid = $1)))::int AS "parents",
        (SELECT COUNT(*) FROM school
          WHERE $1::int IS NULL OR id = $1)::int                     AS "schools",
        (SELECT COUNT(*) FROM students
          WHERE routeid IS NULL
            AND ($1::int IS NULL OR schoolid = $1))::int             AS "studentsWithoutRoute",
        (SELECT COUNT(*) FROM routes
          WHERE driverid IS NULL
            AND ($1::int IS NULL OR schoolid = $1))::int             AS "routesWithoutDriver"`;

    const ABSENT_SQL = `
    SELECT
        s.id                                AS "studentId",
        s.first_name                        AS "student_first_name",
        s.first_name || ' ' || p.first_name || ' ' || p.last_name  AS "studentName",
        s.schoolid                          AS "schoolid",
        r.id                                AS "routeId",
        r.name                              AS "routeName",
        p.id                                AS "parentid",
        p.first_name || ' ' || p.last_name  AS "parentName",
        p.phone                             AS "parentPhone",
        a.morning_status                    AS "morningStatus",
        a.afternoon_status                  AS "afternoonStatus",
        sk.name                             AS "school_name"
    FROM attendance a
    JOIN students s ON s.id = a.studentid
    JOIN routes   r ON r.id = a.routeid
    LEFT JOIN school sk ON s.schoolid = sk.id
    LEFT JOIN users p ON p.id = s.parentid
    WHERE a.attendance_date = $1
        AND (a.morning_status = 'ABSENT' OR a.afternoon_status = 'ABSENT')
        AND ($2::int IS NULL OR r.schoolid = $2)
    ORDER BY s.first_name, p.first_name`;

    const [fleet, tally, counts, absent] = await Promise.all([
        pool.query(FLEET_SQL, [phase, date, SCHOOL_TZ, scope]),
        pool.query(TALLY_SQL, [date, scope]),
        pool.query(COUNTS_SQL, [scope]),
        pool.query(ABSENT_SQL, [date, scope]),
    ]);
    const t = tally.rows[0];
    const c = counts.rows[0];
    
    return {
      date,
      phase,
      routes: fleet.rows[0],
      /* Morning can never be DROPPED_OFF and afternoon can never be ARRIVED,
        but the client reads all five keys, so send them as zeroes. */
      morning: {
        WAITING: t.mWaiting,
        BOARDED: t.mBoarded,
        ARRIVED: t.mArrived,
        DROPPED_OFF: 0,
        ABSENT: t.mAbsent,
        total: t.total,
      },
      afternoon: {
        WAITING: t.aWaiting,
        BOARDED: t.aBoarded,
        ARRIVED: 0,
        DROPPED_OFF: t.aDropped,
        ABSENT: t.aAbsent,
        total: t.total,
      },
      rate: { morning: t.morningRate ?? 0, afternoon: t.afternoonRate ?? 0 },
      counts: {
        students: c.students,
        routes: c.routes,
        drivers: c.drivers,
        parents: c.parents,
        schools: c.schools,
      },
      gaps: {
        studentsWithoutRoute: c.studentsWithoutRoute,
        routesWithoutDriver: c.routesWithoutDriver,
      },
      absentToday: absent.rows,
    };
}

async function getRouteBoard(date, phase, scope = null) {
    const BOARD_SQL = `
    SELECT
        r.id, r.name,
        d.id AS "driverId", d.first_name AS "driverFirstName",
        d.last_name AS "driverLastName", d.phone AS "driverPhone",
        r.morning_status,
        r.afternoon_status,
        /*
            Split into a calendar day and a clock time, both in the school's
            timezone, because the client has to say which day a run belongs to
            and a raw timestamp would leave that to whatever zone the admin's
            laptop happens to be set to. Same boundary attendance_date uses, so
            a run and its register can never disagree about which day it was.
        */
        to_char(${runAt('morning')}   AT TIME ZONE $4, 'YYYY-MM-DD') AS "morningDate",
        to_char(${runAt('morning')}   AT TIME ZONE $4, 'HH24:MI')    AS "morningTime",
        to_char(${runAt('afternoon')} AT TIME ZONE $4, 'YYYY-MM-DD') AS "afternoonDate",
        to_char(${runAt('afternoon')} AT TIME ZONE $4, 'HH24:MI')    AS "afternoonTime",
        COALESCE(sc.n, 0)::int                AS "studentCount",
        COALESCE(pr.settled, 0)::int          AS "settled",
        COALESCE(pr.total, sc.n, 0)::int      AS "total"
    FROM routes r
    LEFT JOIN users d ON d.id = r.driverid
    LEFT JOIN (
        SELECT routeid, COUNT(*) AS n
        FROM students WHERE routeid IS NOT NULL GROUP BY routeid
    ) sc ON sc.routeid = r.id
    LEFT JOIN (
        SELECT
        routeid,
        COUNT(*) AS total,
        COUNT(*) FILTER (
            WHERE CASE WHEN $2 = 'morning' THEN morning_status
                    ELSE afternoon_status END = ANY($3)
        ) AS settled
        FROM attendance
        WHERE attendance_date = $1
        GROUP BY routeid
    ) pr ON pr.routeid = r.id
    WHERE $5::int IS NULL OR r.schoolid = $5
    ORDER BY r.id`;

    const { rows } = await pool.query(BOARD_SQL, [date, phase, TERMINAL, SCHOOL_TZ, scope]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      /* Null when the route has no driver — the client renders "Unassigned". */
      driver: r.driverId
        ? {
            id: r.driverId,
            firstName: r.driverFirstName,
            lastName: r.driverLastName,
            phone: r.driverPhone,
          }
        : null,
      studentCount: r.studentCount,
      /*
            date and time replace the two raw timestamps this used to send.
            The client rendered completedAt ?? startedAt as a bare clock time,
            which is how a run from three weeks ago came to read as "07:42"
            under a panel captioned "today". A day it cannot drop is harder to
            misreport than one it has to work out.
      */
      morning: {
        status: r.morning_status,
        date: r.morningDate,
        time: r.morningTime,
      },
      afternoon: {
        status: r.afternoon_status,
        date: r.afternoonDate,
        time: r.afternoonTime,
      },
      progress: { phase, settled: r.settled, total: r.total },
    }));
}

async function getAttendanceTrend(from, to, scope = null) {
    const TREND_SQL = `
    SELECT
    TO_CHAR(a.attendance_date, 'YYYY-MM-DD') AS "date",
    ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE a.morning_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8 AS "morning",
    ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8 AS "afternoon",
    (a.attendance_date = CURRENT_DATE)        AS "provisional"
    FROM attendance a
    JOIN routes r ON r.id = a.routeid
    WHERE a.attendance_date BETWEEN $1 AND $2
      AND ($3::int IS NULL OR r.schoolid = $3)
    GROUP BY a.attendance_date
    ORDER BY a.attendance_date`;

    const { rows } = await pool.query(TREND_SQL, [from, to, scope]);
    return rows;
}

module.exports = {
    addSchool,
    searchSchoolByName,
    getSchools,
    updateSchool,
    getOverview,
    getRouteBoard,
    getAttendanceTrend
}