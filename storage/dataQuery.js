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

async function searchSchoolByName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT id, name AS school_name
        FROM school
        WHERE name ILIKE $1
        LIMIT 10;
    `, [cleanName]);
    return rows;
}

async function getSchools() {
    const { rows } = await pool.query("SELECT * FROM school");
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

async function getOverview(date, phase) {
    const FLEET_SQL = `
    SELECT
        COUNT(*) FILTER (WHERE st IS NULL)::int         AS "notStarted",
        COUNT(*) FILTER (WHERE st = 'IN_PROGRESS')::int AS "inProgress",
        COUNT(*) FILTER (WHERE st = 'COMPLETED')::int   AS "completed",
        COUNT(*) FILTER (WHERE st = 'CANCELLED')::int   AS "cancelled"
    FROM (
        SELECT CASE WHEN $1 = 'morning' THEN morning_status
                    ELSE afternoon_status END AS st
        FROM routes
    ) r`;

    const TALLY_SQL = `
    SELECT
        COUNT(*)::int                                                AS "total",
        COUNT(*) FILTER (WHERE morning_status   = 'WAITING')::int     AS "mWaiting",
        COUNT(*) FILTER (WHERE morning_status   = 'BOARDED')::int     AS "mBoarded",
        COUNT(*) FILTER (WHERE morning_status   = 'ARRIVED')::int     AS "mArrived",
        COUNT(*) FILTER (WHERE morning_status   = 'ABSENT')::int      AS "mAbsent",
        COUNT(*) FILTER (WHERE afternoon_status = 'WAITING')::int     AS "aWaiting",
        COUNT(*) FILTER (WHERE afternoon_status = 'BOARDED')::int     AS "aBoarded",
        COUNT(*) FILTER (WHERE afternoon_status = 'DROPPED_OFF')::int AS "aDropped",
        COUNT(*) FILTER (WHERE afternoon_status = 'ABSENT')::int      AS "aAbsent",
        ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE morning_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8                       AS "morningRate",
        ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8                       AS "afternoonRate"
    FROM attendance
    WHERE attendance_date = $1`;

    const COUNTS_SQL = `
    SELECT
        (SELECT COUNT(*) FROM students WHERE status = 'ACTIVE')::int AS "students",
        (SELECT COUNT(*) FROM routes)::int                           AS "routes",
        (SELECT COUNT(*) FROM users WHERE role = 'Driver')::int      AS "drivers",
        (SELECT COUNT(*) FROM users WHERE role = 'Parent')::int      AS "parents",
        (SELECT COUNT(*) FROM school)::int                           AS "schools",
        (SELECT COUNT(*) FROM students WHERE routeid IS NULL)::int   AS "studentsWithoutRoute",
        (SELECT COUNT(*) FROM routes   WHERE driverid IS NULL)::int  AS "routesWithoutDriver"`;

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
    ORDER BY s.first_name, p.first_name`;

    const [fleet, tally, counts, absent] = await Promise.all([
        pool.query(FLEET_SQL, [phase]),
        pool.query(TALLY_SQL, [date]),
        pool.query(COUNTS_SQL),
        pool.query(ABSENT_SQL, [date]),
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

async function getRouteBoard(date, phase) {
    const BOARD_SQL = `
    SELECT
        r.id, r.name,
        d.id AS "driverId", d.first_name AS "driverFirstName",
        d.last_name AS "driverLastName", d.phone AS "driverPhone",
        r.morning_status,   r.morning_started_at,   r.morning_completed_at,
        r.afternoon_status, r.afternoon_started_at, r.afternoon_completed_at,
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
    ORDER BY r.id`;

    const { rows } = await pool.query(BOARD_SQL, [date, phase, TERMINAL]);
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
      morning: {
        status: r.morning_status,
        startedAt: r.morning_started_at,
        completedAt: r.morning_completed_at,
      },
      afternoon: {
        status: r.afternoon_status,
        startedAt: r.afternoon_started_at,
        completedAt: r.afternoon_completed_at,
      },
      progress: { phase, settled: r.settled, total: r.total },
    }));
}

async function getAttendanceTrend(from, to) {
    const TREND_SQL = `
    SELECT
    TO_CHAR(attendance_date, 'YYYY-MM-DD') AS "date",
    ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE morning_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8 AS "morning",
    ROUND(100.0 * (COUNT(*) - COUNT(*) FILTER (WHERE afternoon_status = 'ABSENT'))
            / NULLIF(COUNT(*), 0), 1)::float8 AS "afternoon",
    (attendance_date = CURRENT_DATE)        AS "provisional"
    FROM attendance
    WHERE attendance_date BETWEEN $1 AND $2
    GROUP BY attendance_date
    ORDER BY attendance_date`;

    const { rows } = await pool.query(TREND_SQL, [from, to]);
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