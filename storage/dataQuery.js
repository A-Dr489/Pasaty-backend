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

    /* -----------------------------------------------------------------------
       THE RATE IS OVER SESSIONS THAT HAPPENED, NOT OVER THE REGISTER

       An attendance row is written when the MORNING run starts, and its
       afternoon_status stays null until an afternoon run starts. So a route
       that ran only the morning leaves a register full of afternoons that
       never happened - 9 of today's 25 rows, and 19 of 30 on 6 October.

       Dividing by COUNT(*) counted every one of those as present, because
       null is not 'ABSENT'. That is how 3 October came to report 100%
       afternoon attendance on a day when not one child had an afternoon
       status at all, and how 6 October read 90% while 26% were delivered.

       COUNT(a.afternoon_status) counts the non-null ones, so the denominator
       is the number of sessions that actually took place. With none, the rate
       is NULL rather than a confident 100% - the caller shows a dash.

       `total` is still sent, so the client can say "16 recorded of 25 on the
       register" and the gap is visible instead of silently averaged away.
    ----------------------------------------------------------------------- */
    const TALLY_SQL = `
    SELECT
        COUNT(*)::int                                                AS "total",
        COUNT(a.morning_status)::int                                 AS "mRecorded",
        COUNT(a.afternoon_status)::int                               AS "aRecorded",
        COUNT(*) FILTER (WHERE a.morning_status   = 'WAITING')::int     AS "mWaiting",
        COUNT(*) FILTER (WHERE a.morning_status   = 'BOARDED')::int     AS "mBoarded",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ARRIVED')::int     AS "mArrived",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ABSENT')::int      AS "mAbsent",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'WAITING')::int     AS "aWaiting",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'BOARDED')::int     AS "aBoarded",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'DROPPED_OFF')::int AS "aDropped",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT')::int      AS "aAbsent",
        ROUND(100.0 * (COUNT(a.morning_status) - COUNT(*) FILTER (WHERE a.morning_status = 'ABSENT'))
            / NULLIF(COUNT(a.morning_status), 0), 1)::float8         AS "morningRate",
        ROUND(100.0 * (COUNT(a.afternoon_status) - COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(a.afternoon_status), 0), 1)::float8       AS "afternoonRate"
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
        but the client reads all five keys, so send them as zeroes.

        `recorded` is how many of the day's rows this phase actually has a
        status for, and it is what the five counts add up to. `total` is the
        whole register. Where they differ, that many children had no session
        in this phase - see TALLY_SQL above. */
      morning: {
        WAITING: t.mWaiting,
        BOARDED: t.mBoarded,
        ARRIVED: t.mArrived,
        DROPPED_OFF: 0,
        ABSENT: t.mAbsent,
        recorded: t.mRecorded,
        total: t.total,
      },
      afternoon: {
        WAITING: t.aWaiting,
        BOARDED: t.aBoarded,
        ARRIVED: 0,
        DROPPED_OFF: t.aDropped,
        ABSENT: t.aAbsent,
        recorded: t.aRecorded,
        total: t.total,
      },
      /* Null, not zero, when nothing was recorded. A phase that never ran has
        no attendance rate, and 0% would read as everybody being absent while
        the old ?? 0 made it 100% - both of them statements about a day that
        did not happen. */
      rate: { morning: t.morningRate, afternoon: t.afternoonRate },
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

/* ---------------------------------------------------------------------------
   THE LIVE MONITOR

   Today's runs, not each route's last run - which is the whole difference
   between this and getRouteBoard above. Every status here is passed through
   statusOn, so a run from a previous day reads as nothing at all rather than
   as something happening now. That is what stops a trip nobody closed - there
   are four of those in production, one open since September - from sitting in
   this board claiming to be on the road.

   Each route lands in exactly ONE state for the day, so the four counts always
   add up to the number of rows and no route can appear under two filters:

     RUNNING      either phase is in progress
     PARTLY       exactly one phase has finished - the normal state of every
                  route between the morning arrival and the afternoon start
     DONE         both phases finished
     NOT_STARTED  neither phase has a status belonging to this day

   CANCELLED, which nothing emits yet, falls into NOT_STARTED. That matches
   what the attendance layer already believes: STARTABLE treats a cancelled run
   as one that can be started, so it is not started.

   Three statements rather than one. The per-student rows are the reason: a
   single query would repeat every route's columns once per child, and the
   expanded rows need the children anyway. Today that is 25 rows across 7
   routes, which is what makes it cheap enough for the page to poll.
--------------------------------------------------------------------------- */
async function getLiveBoard(date, scope = null) {
    const ROUTES_SQL = `
    WITH runs AS (
        SELECT r.id, r.name, r.schoolid, r.driverid,
               (r.geo IS NOT NULL) AS has_geometry,
               ${statusOn('morning', '$1', '$2')}   AS m_status,
               ${statusOn('afternoon', '$1', '$2')} AS a_status,
               r.morning_started_at, r.morning_completed_at,
               r.afternoon_started_at, r.afternoon_completed_at
        FROM routes r
        WHERE $3::int IS NULL OR r.schoolid = $3
    )
    SELECT
        x.id, x.name, x.has_geometry AS "hasGeometry",
        d.id AS "driverId", d.first_name AS "driverFirstName",
        d.last_name AS "driverLastName", d.phone AS "driverPhone",
        x.m_status AS "morningStatus",
        x.a_status AS "afternoonStatus",
        /*
            The timestamps are gated on the status, not sent raw. A route out
            on the road right now still carries the previous run's
            completed_at, and a run with no status today carries both of
            yesterday's - printing either would date this morning's work to
            last week. Only the columns the status vouches for survive.
        */
        CASE WHEN x.m_status IS NOT NULL
             THEN to_char(x.morning_started_at AT TIME ZONE $2, 'HH24:MI') END   AS "morningStarted",
        CASE WHEN x.m_status = 'COMPLETED'
             THEN to_char(x.morning_completed_at AT TIME ZONE $2, 'HH24:MI') END AS "morningCompleted",
        CASE WHEN x.a_status IS NOT NULL
             THEN to_char(x.afternoon_started_at AT TIME ZONE $2, 'HH24:MI') END   AS "afternoonStarted",
        CASE WHEN x.a_status = 'COMPLETED'
             THEN to_char(x.afternoon_completed_at AT TIME ZONE $2, 'HH24:MI') END AS "afternoonCompleted",
        /*
            How long the run has been open, for the phase that is open. This is
            the column that makes an abandoned trip obvious: a run still
            "in progress" after nine hours is not a bus on the road, and
            nothing else on the page would say so.
        */
        CASE WHEN x.m_status = 'IN_PROGRESS'
             THEN floor(extract(epoch FROM (now() - x.morning_started_at)))::int END   AS "morningElapsed",
        CASE WHEN x.a_status = 'IN_PROGRESS'
             THEN floor(extract(epoch FROM (now() - x.afternoon_started_at)))::int END AS "afternoonElapsed",
        CASE
            WHEN x.m_status = 'IN_PROGRESS' OR x.a_status = 'IN_PROGRESS' THEN 'RUNNING'
            WHEN x.m_status = 'COMPLETED'  AND x.a_status = 'COMPLETED'   THEN 'DONE'
            WHEN x.m_status = 'COMPLETED'   OR x.a_status = 'COMPLETED'   THEN 'PARTLY'
            ELSE 'NOT_STARTED'
        END AS state,
        --Running first, because that is what the page is for.
        CASE
            WHEN x.m_status = 'IN_PROGRESS' OR x.a_status = 'IN_PROGRESS' THEN 0
            WHEN x.m_status = 'COMPLETED'  AND x.a_status = 'COMPLETED'   THEN 2
            WHEN x.m_status = 'COMPLETED'   OR x.a_status = 'COMPLETED'   THEN 1
            ELSE 3
        END AS sort_rank,
        COALESCE(sc.n, 0)::int AS "studentCount"
    FROM runs x
    LEFT JOIN users d ON d.id = x.driverid
    LEFT JOIN (
        SELECT routeid, COUNT(*) AS n
        FROM students WHERE routeid IS NOT NULL GROUP BY routeid
    ) sc ON sc.routeid = x.id
    ORDER BY sort_rank, x.id`;

    //Counts for the collapsed row. `recorded` is how many children the phase
    //actually has a status for, which is never assumed to be everyone on the
    //register - a route that ran only the morning has a register full of
    //afternoons that never happened.
    const TALLY_SQL = `
    SELECT a.routeid,
        COUNT(*)::int                                                   AS "onRegister",
        COUNT(a.morning_status)::int                                    AS "mRecorded",
        COUNT(*) FILTER (WHERE a.morning_status   = 'WAITING')::int     AS "mWaiting",
        COUNT(*) FILTER (WHERE a.morning_status   = 'BOARDED')::int     AS "mBoarded",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ARRIVED')::int     AS "mArrived",
        COUNT(*) FILTER (WHERE a.morning_status   = 'ABSENT')::int      AS "mAbsent",
        COUNT(a.afternoon_status)::int                                  AS "aRecorded",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'WAITING')::int     AS "aWaiting",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'BOARDED')::int     AS "aBoarded",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'DROPPED_OFF')::int AS "aDropped",
        COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT')::int      AS "aAbsent"
    FROM attendance a
    JOIN routes r ON r.id = a.routeid
    WHERE a.attendance_date = $1
      AND ($2::int IS NULL OR r.schoolid = $2)
    GROUP BY a.routeid`;

    /*
        The children behind those counts, for an expanded row.

        The waypoints join is LEFT and matches on the route AS WELL AS the
        student: a child attached to a route but given no stop of their own
        still has to appear here, because they are on the bus and the driver
        has them on the register. An inner join is how they became invisible
        on the live map.
    */
    const STUDENTS_SQL = `
    SELECT
        a.routeid, a.studentid, a.id AS "attendanceId",
        s.first_name                                AS "firstName",
        CONCAT(p.first_name, ' ', p.last_name)      AS "parentName",
        p.phone                                     AS "parentPhone",
        w.sort_number                               AS "sortNumber",
        a.morning_status                            AS "morningStatus",
        a.afternoon_status                          AS "afternoonStatus",
        to_char(a.morning_boarded_at      AT TIME ZONE $2, 'HH24:MI') AS "morningBoardedAt",
        to_char(a.morning_arrived_at      AT TIME ZONE $2, 'HH24:MI') AS "morningArrivedAt",
        to_char(a.afternoon_boarded_at    AT TIME ZONE $2, 'HH24:MI') AS "afternoonBoardedAt",
        to_char(a.afternoon_dropped_off_at AT TIME ZONE $2, 'HH24:MI') AS "afternoonDroppedOffAt"
    FROM attendance a
    JOIN routes   r ON r.id = a.routeid
    JOIN students s ON s.id = a.studentid
    LEFT JOIN users p ON p.id = s.parentid
    LEFT JOIN waypoints w ON w.routeid = a.routeid AND w.studentid = a.studentid
    WHERE a.attendance_date = $1
      AND ($3::int IS NULL OR r.schoolid = $3)
    ORDER BY a.routeid, w.sort_number NULLS LAST, s.first_name`;

    const [routes, tallies, students] = await Promise.all([
        pool.query(ROUTES_SQL, [date, SCHOOL_TZ, scope]),
        pool.query(TALLY_SQL, [date, scope]),
        pool.query(STUDENTS_SQL, [date, SCHOOL_TZ, scope]),
    ]);

    const tallyOf = new Map(tallies.rows.map((row) => [row.routeid, row]));
    const childrenOf = new Map();
    for(const row of students.rows) {
        if(!childrenOf.has(row.routeid)) childrenOf.set(row.routeid, []);
        childrenOf.get(row.routeid).push({
            studentid: row.studentid,
            attendanceId: row.attendanceId,
            name: row.firstName,
            parentName: row.parentName,
            parentPhone: row.parentPhone,
            sortNumber: row.sortNumber,
            morning: {
                status: row.morningStatus,
                boardedAt: row.morningBoardedAt,
                arrivedAt: row.morningArrivedAt,
            },
            afternoon: {
                status: row.afternoonStatus,
                boardedAt: row.afternoonBoardedAt,
                droppedOffAt: row.afternoonDroppedOffAt,
            },
        });
    }

    const counts = { RUNNING: 0, PARTLY: 0, DONE: 0, NOT_STARTED: 0 };

    const rows = routes.rows.map((r) => {
        const t = tallyOf.get(r.id);
        counts[r.state] += 1;

        return {
            id: r.id,
            name: r.name,
            state: r.state,
            hasGeometry: r.hasGeometry,
            studentCount: r.studentCount,
            //Null when nobody is assigned - the client says "Unassigned".
            driver: r.driverId
                ? {
                    id: r.driverId,
                    firstName: r.driverFirstName,
                    lastName: r.driverLastName,
                    phone: r.driverPhone,
                }
                : null,
            //How many children the day's register holds for this route, which
            //is not the same as how many are assigned to it: the register is
            //written when a run starts, so a route that has not run has none.
            onRegister: t ? t.onRegister : 0,
            morning: {
                status: r.morningStatus,
                started: r.morningStarted,
                completed: r.morningCompleted,
                elapsedSeconds: r.morningElapsed,
                tally: {
                    recorded: t ? t.mRecorded : 0,
                    WAITING: t ? t.mWaiting : 0,
                    BOARDED: t ? t.mBoarded : 0,
                    ARRIVED: t ? t.mArrived : 0,
                    ABSENT: t ? t.mAbsent : 0,
                },
            },
            afternoon: {
                status: r.afternoonStatus,
                started: r.afternoonStarted,
                completed: r.afternoonCompleted,
                elapsedSeconds: r.afternoonElapsed,
                tally: {
                    recorded: t ? t.aRecorded : 0,
                    WAITING: t ? t.aWaiting : 0,
                    BOARDED: t ? t.aBoarded : 0,
                    DROPPED_OFF: t ? t.aDropped : 0,
                    ABSENT: t ? t.aAbsent : 0,
                },
            },
            students: childrenOf.get(r.id) ?? [],
        };
    });

    return {
        date,
        //The page polls, so it has to be able to say how old what it is showing
        //is. Taken here rather than on arrival, which would hide a slow query.
        generatedAt: new Date().toISOString(),
        counts: { ...counts, total: rows.length },
        routes: rows,
    };
}

async function getAttendanceTrend(from, to, scope = null) {
    /* Same denominator as TALLY_SQL, for the same reason, and it matters more
       here: every day in this series was measured against the whole register,
       so the afternoon line sat near 100% for months while under half the
       children were being delivered. A day with nothing recorded comes back
       null and the chart leaves a gap in the line rather than drawing a
       point nobody earned. */
    const TREND_SQL = `
    SELECT
    TO_CHAR(a.attendance_date, 'YYYY-MM-DD') AS "date",
    COUNT(a.morning_status)::int             AS "morningRecorded",
    COUNT(a.afternoon_status)::int           AS "afternoonRecorded",
    COUNT(*)::int                            AS "total",
    ROUND(100.0 * (COUNT(a.morning_status) - COUNT(*) FILTER (WHERE a.morning_status = 'ABSENT'))
            / NULLIF(COUNT(a.morning_status), 0), 1)::float8 AS "morning",
    ROUND(100.0 * (COUNT(a.afternoon_status) - COUNT(*) FILTER (WHERE a.afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(a.afternoon_status), 0), 1)::float8 AS "afternoon",
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
    getLiveBoard,
    getAttendanceTrend
}