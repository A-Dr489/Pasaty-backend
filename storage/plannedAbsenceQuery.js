const pool = require("./pool.js");
const { httpError } = require("../utils/functions.js");
const { withTransaction } = require("./AttendanceQuery.js");
const { ROUTE_STATUS, ATTENDANCE_STATUS, PHASE } = require("../utils/enum.js");

const SCHOOL_TZ = process.env.SCHOOL_TZ;

/* ===========================================================================
   PLANNED ABSENCE - a parent saying their child is not riding

   Morning only. One row per child per day; the row is a declaration, not a
   status. It becomes an ordinary ABSENT attendance row when that morning's run
   starts, and from then on the attendance table is the only thing anything
   reads.

   The row is deliberately NOT deleted when it is consumed. restartTrip wipes
   the day's attendance rows, and a restarted run has to be able to rebuild the
   same absences from somewhere.
   =========================================================================== */

//Today as the school reckons it. Every date in this file is compared against
//this and never against a clock on a phone.
const TODAY = `(now() AT TIME ZONE $TZ)::date`;

async function schoolToday() {
    const { rows } = await pool.query(
        `SELECT ${TODAY.replace("$TZ", "$1")}::text AS today`,
        [SCHOOL_TZ]
    );
    return rows[0].today;
}

/*
    Ownership, as a query rather than a check.

    Asking the database "is this student yours" and acting on the answer leaves
    a gap between the two. Every statement below carries parentid in its own
    WHERE instead, so a student that is not the caller's simply matches nothing.
*/
async function studentBelongsToParent(studentid, parentid) {
    const { rows } = await pool.query(
        "SELECT 1 FROM students WHERE id = $1 AND parentid = $2",
        [studentid, parentid]
    );
    return rows.length > 0;
}

/*
    Declare one day.

    Idempotent by the unique key. The no-op DO UPDATE is what makes RETURNING
    fire on a row that already existed - DO NOTHING returns nothing at all, and
    the caller could not then tell "created" from "already there". xmax is 0
    only on a genuine insert, which is what separates the two.
*/
async function declareDay(studentid, date, createdby) {
    const { rows } = await pool.query(
        `INSERT INTO planned_absence (studentid, date, createdby)
         VALUES ($1, $2::date, $3)
         ON CONFLICT (studentid, date)
         DO UPDATE SET created_at = planned_absence.created_at
         RETURNING id, to_char(date, 'YYYY-MM-DD') AS date, (xmax = 0) AS created`,
        [studentid, date, createdby]
    );
    return rows[0];
}

//Cancel one declared day. Scoped by parent, so another parent's row is simply
//not found rather than forbidden.
async function cancelDay(studentid, date, parentid) {
    const { rows } = await pool.query(
        `DELETE FROM planned_absence pa
          USING students s
          WHERE pa.studentid = $1
            AND pa.date = $2::date
            AND s.id = pa.studentid
            AND s.parentid = $3
        RETURNING pa.id`,
        [studentid, date, parentid]
    );
    return rows.length > 0;
}

/*
    Everything this parent has declared in a window, newest day last so the
    client can render a calendar without sorting it again.
*/
async function listForParent(parentid, from, to) {
    const { rows } = await pool.query(
        `SELECT pa.id, pa.studentid,
                to_char(pa.date, 'YYYY-MM-DD') AS date,
                s.first_name AS student_name,
                /* The column is created_at, the only snake_case timestamp in a
                   schema that otherwise spells it createdat. Aliased back so
                   the field the mobile app was given keeps its documented
                   name - the table's spelling is not the API's problem. */
                pa.created_at AS createdat
           FROM planned_absence pa
           JOIN students s ON s.id = pa.studentid
          WHERE s.parentid = $1
            AND pa.date >= $2::date
            AND pa.date <= $3::date
          ORDER BY pa.date, s.first_name`,
        [parentid, from, to]
    );
    return rows;
}

/*
    What state today's morning run is in for this child's route, which is what
    decides whether a declaration for today is a row or a live change.

    Keyed on the student rather than the route because the caller is a parent -
    they know their child, not which bus the child is on. A student with no
    route has no run to be in, which reads here as no row.
*/
async function morningRunStateFor(studentid) {
    const { rows } = await pool.query(
        `SELECT r.id AS routeid,
                r.morning_status,
                (r.morning_started_at AT TIME ZONE $2)::date = ${TODAY.replace("$TZ", "$2")}
                    AS started_today,
                a.id AS attendanceid,
                a.morning_status AS attendance_status
           FROM students s
           JOIN routes r ON r.id = s.routeid
           LEFT JOIN attendance a
                  ON a.studentid = s.id
                 AND a.routeid = r.id
                 AND a.attendance_date = ${TODAY.replace("$TZ", "$2")}
          WHERE s.id = $1`,
        [studentid, SCHOOL_TZ]
    );
    return rows[0] ?? null;
}

/*
    The live path: a parent marking their child absent on a run already under
    way - the sick-on-waking case.

    Deliberately not absentMorning(). That one demands the assigned driver and
    would answer a parent with 403, and it records the change as the driver's.
    The guards here are the parent's equivalents: the child must be theirs, the
    run must be in progress, and the child must not already be aboard.
*/
async function parentAbsentToday(studentid, parentid) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT a.id, a.routeid, a.morning_status, a.studentid,
                    s.first_name AS student_name, s.parentid,
                    r.morning_status AS route_morning_status
               FROM attendance a
               JOIN students s ON s.id = a.studentid
               JOIN routes r ON r.id = a.routeid
              WHERE a.studentid = $1
                AND a.attendance_date = ${TODAY.replace("$TZ", "$2")}
                FOR UPDATE OF a`,
            [studentid, SCHOOL_TZ]
        );
        if (rows.length === 0) throw httpError(404, "No attendance for today");

        const row = rows[0];
        if (row.parentid !== parentid) throw httpError(403, "Not your student");
        if (row.route_morning_status !== ROUTE_STATUS.IN_PROGRESS) {
            throw httpError(409, "Morning route is not in progress");
        }

        const oldStatus = row.morning_status;

        //Already declared. Idempotent, so a retry is not an error.
        if (oldStatus === ATTENDANCE_STATUS.ABSENT) {
            return { changed: false, attendanceid: row.id, routeid: row.routeid,
                     studentid: row.studentid, student_name: row.student_name,
                     old_status: oldStatus, new_status: oldStatus };
        }

        /*
            Past WAITING means the child is on the bus. A parent cannot take
            back a boarding - only the driver, who can see them, can.
        */
        if (oldStatus !== null && oldStatus !== ATTENDANCE_STATUS.WAITING) {
            throw httpError(409, `Cannot declare absent from status ${oldStatus}`);
        }

        await client.query(
            `UPDATE attendance
                SET morning_status = $2, updated_by = $3, updated_at = now()
              WHERE id = $1`,
            [row.id, ATTENDANCE_STATUS.ABSENT, parentid]
        );

        //Recorded as the parent's own change, so the register can later show
        //who took a child off the run and when.
        await client.query(
            `INSERT INTO attendance_audit
               (attendanceid, phase, old_status, new_status, changed_by, changed_by_role)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [row.id, PHASE.MORNING, oldStatus, ATTENDANCE_STATUS.ABSENT, parentid, "parent"]
        );

        return { changed: true, attendanceid: row.id, routeid: row.routeid,
                 studentid: row.studentid, student_name: row.student_name,
                 old_status: oldStatus, new_status: ATTENDANCE_STATUS.ABSENT };
    });
}

module.exports = {
    schoolToday,
    studentBelongsToParent,
    declareDay,
    cancelDay,
    listForParent,
    morningRunStateFor,
    parentAbsentToday
};