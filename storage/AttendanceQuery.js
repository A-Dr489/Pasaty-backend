// require("dotenv").config();
const pool = require("./pool.js");
const { httpError } = require('../utils/functions.js');
const { ROUTE_STATUS, ATTENDANCE_STATUS } = require("../utils/enum.js");

//Helper Function
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
//Helper Function
async function afternoonTransition(attendanceid, driverid, { from, to, tsColumn }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.routeid, a.afternoon_status,
              a.${tsColumn} AS current_at,
              r.driverid, r.afternoon_status AS route_afternoon_status
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [attendanceid]
    );
    if (rows.length === 0) throw httpError(404, 'Attendance not found');

    const row = rows[0];
    if (row.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (row.route_afternoon_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, 'Afternoon route is not in progress');
    }

    const oldStatus = row.afternoon_status;

    // Idempotent re-tap: already at target -> return current, no second write.
    if (oldStatus === to) {
      return {
        changed: false,
        attendanceid: row.id,
        routeid: row.routeid,
        old_status: to,
        new_status: to,
        at: row.current_at,
      };
    }

    const { rows: upd } = await client.query(
      `UPDATE attendance
          SET afternoon_status = $2,
              ${tsColumn} = now()
        WHERE id = $1
      RETURNING ${tsColumn} AS at`,
      [attendanceid, to]
    );

    return {
      changed: true,
      attendanceid: row.id,
      routeid: row.routeid,
      old_status: oldStatus,
      new_status: to,
      at: upd[0].at,
    };
  });
}

const STARTABLE = [null, ROUTE_STATUS.CANCELLED];
const SCHOOL_TZ = process.env.SCHOOL_TZ;

async function startMorningRoute(routeid, driverid) {
    return withTransaction(async (client) => {
        const { rows: routeRows } = await client.query(
            `SELECT id, driverid, morning_status
                FROM routes
                WHERE id = $1
                FOR UPDATE`,
            [routeid]
        );
        if (routeRows.length === 0) throw httpError(404, 'Route not found');
        const route = routeRows[0];
        if (route.driverid !== driverid) {
            throw httpError(403, 'Driver not assigned to this route');
        }
        if(route.morning_status === ROUTE_STATUS.IN_PROGRESS) {
          const { rows: students } = await client.query(
            `SELECT a.id AS attendanceid, a.studentid AS id,
                    s.first_name, a.morning_status AS status
                FROM attendance a
                JOIN students s ON s.id = a.studentid
                WHERE a.routeid = $1
                AND a.attendance_date = (now() AT TIME ZONE $2)::date
                ORDER BY s.id`,
            [routeid, SCHOOL_TZ]
          );
          return {
            route: {
              id: routeid,
              morning_status: route.morning_status,
              morning_started_at: route.morning_started_at,
            },
            students,
          }
        }
        if (!STARTABLE.includes(route.morning_status)) {
            throw httpError(409, `Morning route already ${route.morning_status}`);
        }

        const { rows: updRows } = await client.query(
          `UPDATE routes
            SET morning_status = $2,
              morning_started_at = now()
            WHERE id = $1
            RETURNING morning_status, morning_started_at`,
          [routeid, ROUTE_STATUS.IN_PROGRESS],
        );

        //    Insert one WAITING attendance row per student, for school-local today.
        //    ON CONFLICT keeps restart idempotent (no duplicate-day rows).
        await client.query(
        `INSERT INTO attendance (routeid, studentid, attendance_date, morning_status)
            SELECT s.routeid, s.id, (now() AT TIME ZONE $2)::date, $3
            FROM students s
            WHERE s.routeid = $1
            ON CONFLICT (routeid, studentid, attendance_date) DO NOTHING`,
        [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.WAITING]
        );

        //    Pickup list for the response + broadcast.
        //    attendanceid included so the driver client can call PIECE 2 (board).
        const { rows: students } = await client.query(
        `SELECT a.id AS attendanceid, a.studentid AS id,
                s.first_name, a.morning_status AS status
            FROM attendance a
            JOIN students s ON s.id = a.studentid
            WHERE a.routeid = $1
            AND a.attendance_date = (now() AT TIME ZONE $2)::date
            ORDER BY s.id`,
        [routeid, SCHOOL_TZ]
        );

        return {
          route: {
            id: routeid,
            morning_status: updRows[0].morning_status,
            morning_started_at: updRows[0].morning_started_at,
          },
          students,
        };

    })
}

async function boardMorning(attendanceid, driverid) {
    return withTransaction(async (client) => {
    // Lock the attendance row; pull its route's owner + morning status.
    const { rows } = await client.query(
      `SELECT a.id, a.routeid, a.morning_status,
              r.driverid, r.morning_status AS route_morning_status,
              a.morning_boarded_at
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [attendanceid]
    );
    if (rows.length === 0) throw httpError(404, 'Attendance not found');

    const row = rows[0];
    if (row.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (row.route_morning_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, 'Morning route is not in progress');
    }

    const oldStatus = row.morning_status;

    // // Idempotent re-tap: already boarded -> return current, no second write.
    if (oldStatus === ATTENDANCE_STATUS.BOARDED) {
      return {
        changed: false,
        attendanceid: row.id,
        routeid: row.routeid,
        old_status: oldStatus,
        new_status: oldStatus,
        boarded_at: row.morning_boarded_at,
      };
    }
    // if (oldStatus !== ATTENDANCE_STATUS.WAITING) {
    //   throw httpError(409, `Cannot board from status ${oldStatus}`);
    // }

    const { rows: upd } = await client.query(
      `UPDATE attendance
          SET morning_status = $2,
              morning_boarded_at = now()
        WHERE id = $1
      RETURNING morning_boarded_at`,
      [attendanceid, ATTENDANCE_STATUS.BOARDED]
    );

    return {
      changed: true,
      attendanceid: row.id,
      routeid: row.routeid,
      old_status: oldStatus, // real prior value, not hardcoded
      new_status: ATTENDANCE_STATUS.BOARDED,
      boarded_at: upd[0].morning_boarded_at,
    };
  });
}

async function absentMorning(attendanceid, driverid) {
    return withTransaction(async (client) => {
    // Lock the attendance row; pull its route's owner + morning status.
    const { rows } = await client.query(
      `SELECT a.id, a.routeid, a.morning_status,
              r.driverid, r.morning_status AS route_morning_status,
              a.morning_boarded_at
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [attendanceid]
    );
    if (rows.length === 0) throw httpError(404, 'Attendance not found');

    const row = rows[0];
    if (row.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (row.route_morning_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, 'Morning route is not in progress');
    }

    const oldStatus = row.morning_status;

    // // Idempotent re-tap: already boarded -> return current, no second write.
    if (oldStatus === ATTENDANCE_STATUS.ABSENT) {
      return {
        changed: false,
        attendanceid: row.id,
        routeid: row.routeid,
        old_status: oldStatus,
        new_status: oldStatus,
      };
    }
    // if (oldStatus !== ATTENDANCE_STATUS.WAITING) {
    //   throw httpError(409, `Cannot board from status ${oldStatus}`);
    // }

   await client.query(
      `UPDATE attendance
          SET morning_status = $2,
          morning_boarded_at = NULL,
          morning_arrived_at = NULL
        WHERE id = $1`,
      [attendanceid, ATTENDANCE_STATUS.ABSENT]
    );

    return {
      changed: true,
      attendanceid: row.id,
      routeid: row.routeid,
      old_status: oldStatus, // real prior value, not hardcoded
      new_status: ATTENDANCE_STATUS.ABSENT,
    };
  });
}

async function completeMorningRoute(routeid, driverid) {
  return withTransaction(async (client) => {
    const { rows: routeRows } = await client.query(
      `SELECT id, driverid, morning_status
         FROM routes
        WHERE id = $1
        FOR UPDATE`,
      [routeid]
    );
    if (routeRows.length === 0) throw httpError(404, 'Route not found');

    const route = routeRows[0];
    if (route.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (route.morning_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, `Morning route is ${route.morning_status}, cannot complete`);
    }

    const { rows: updRows } = await client.query(
      `UPDATE routes
          SET morning_status = $2,
              morning_completed_at = now()
        WHERE id = $1
      RETURNING morning_completed_at`,
      [routeid, ROUTE_STATUS.COMPLETED]
    );

    const today = `(now() AT TIME ZONE $2)::date`;

    await client.query(
      `UPDATE attendance
          SET morning_status = $3,
              morning_arrived_at = now()
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND morning_status = $4`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.ARRIVED, ATTENDANCE_STATUS.BOARDED]
    );

    await client.query(
      `UPDATE attendance
          SET morning_status = $3
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND morning_status = $4`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.ABSENT, ATTENDANCE_STATUS.WAITING]
    );

    const { rows: finalStudents } = await client.query(
      `SELECT a.id AS attendanceid, a.studentid AS id,
              s.first_name, a.morning_status AS status
         FROM attendance a
         JOIN students s ON s.id = a.studentid
        WHERE a.routeid = $1
          AND a.attendance_date = ${today}
        ORDER BY s.id`,
      [routeid, SCHOOL_TZ]
    );

    const summary = {
      total_students: finalStudents.length,
      arrived: finalStudents.filter((s) => s.status === ATTENDANCE_STATUS.ARRIVED).length,
      absent: finalStudents.filter((s) => s.status === ATTENDANCE_STATUS.ABSENT).length,
    };

    return {
      routeid: routeid,
      completed_at: updRows[0].morning_completed_at,
      summary,
      students: finalStudents,
    };
  });
}

async function startAfternoonRoute(routeid, driverid) {
  return withTransaction(async (client) => {
    const { rows: routeRows } = await client.query(
      `SELECT id, driverid, morning_status, afternoon_status
         FROM routes
        WHERE id = $1
        FOR UPDATE`,
      [routeid]
    );
    if (routeRows.length === 0) throw httpError(404, 'Route not found');

    const route = routeRows[0];
    const today = `(now() AT TIME ZONE $2)::date`;
    if (route.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (route.morning_status !== ROUTE_STATUS.COMPLETED) {
      throw httpError(409, 'Finish the morning route before starting the afternoon');
    }
    if(route.afternoon_status === ROUTE_STATUS.IN_PROGRESS) {
          const { rows: students } = await client.query(
            `SELECT a.id AS attendanceid, a.studentid AS id,
                    s.first_name,
                    a.morning_status, a.afternoon_status
              FROM attendance a
              JOIN students s ON s.id = a.studentid
              WHERE a.routeid = $1
                AND a.attendance_date = ${today}
              ORDER BY s.id`,
            [routeid, SCHOOL_TZ]
          );
          return {
            route: {
              id: routeid,
              morning_status: route.morning_status,
              morning_started_at: route.morning_started_at,
            },
            students,
          }
        }
    if (!STARTABLE.includes(route.afternoon_status)) {
      throw httpError(409, `Afternoon route already ${route.afternoon_status}`);
    }

    const { rows: updRows } = await client.query(
      `UPDATE routes
          SET afternoon_status = $2,
              afternoon_started_at = now()
        WHERE id = $1
      RETURNING afternoon_status, afternoon_started_at`,
      [routeid, ROUTE_STATUS.IN_PROGRESS]
    );

    // Carry morning ABSENT forward; everyone else resets to WAITING.
    await client.query(
      `UPDATE attendance
          SET afternoon_status = 
                CASE WHEN morning_status = 'ABSENT' THEN 'ABSENT' ELSE 'WAITING' END
        WHERE routeid = $1
          AND attendance_date = ${today}`,
      [routeid, SCHOOL_TZ]
    );

    const { rows: students } = await client.query(
      `SELECT a.id AS attendanceid, a.studentid AS id,
              s.first_name,
              a.morning_status, a.afternoon_status
         FROM attendance a
         JOIN students s ON s.id = a.studentid
        WHERE a.routeid = $1
          AND a.attendance_date = ${today}
        ORDER BY s.id`,
      [routeid, SCHOOL_TZ]
    );

    return {
      route: {
        id: routeid,
        afternoon_status: updRows[0].afternoon_status,
        afternoon_started_at: updRows[0].afternoon_started_at,
      },
      students,
    };
  });
}

function boardAfternoon(attendanceid, driverid) {
  return afternoonTransition(attendanceid, driverid, {
    from: ATTENDANCE_STATUS.WAITING,  //WAITING
    to: ATTENDANCE_STATUS.BOARDED,  //BOARDED
    tsColumn: 'afternoon_boarded_at',
  });
}

async function absentAfternoon(attendanceid, driverid) {
    return withTransaction(async (client) => {
    // Lock the attendance row; pull its route's owner + morning status.
    const { rows } = await client.query(
      `SELECT a.id, a.routeid, a.afternoon_status,
              r.driverid, r.afternoon_status AS route_afternoon_status,
              a.afternoon_boarded_at
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [attendanceid]
    );
    if (rows.length === 0) throw httpError(404, 'Attendance not found');

    const row = rows[0];
    if (row.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (row.route_afternoon_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, 'Morning route is not in progress');
    }

    const oldStatus = row.afternoon_status;

    // // Idempotent re-tap: already boarded -> return current, no second write.
    if (oldStatus === ATTENDANCE_STATUS.ABSENT) {
      return {
        changed: false,
        attendanceid: row.id,
        routeid: row.routeid,
        old_status: oldStatus,
        new_status: oldStatus,
      };
    }

    await client.query(
      `UPDATE attendance
          SET afternoon_status = $2,
          afternoon_boarded_at = NULL,
          afternoon_dropped_off_at = NULL
        WHERE id = $1`,
      [attendanceid, ATTENDANCE_STATUS.ABSENT]
    );

    return {
      changed: true,
      attendanceid: row.id,
      routeid: row.routeid,
      old_status: oldStatus, // real prior value, not hardcoded
      new_status: ATTENDANCE_STATUS.ABSENT,
    };
  });
}

function dropoffAfternoon(attendanceid, driverid) {
  return afternoonTransition(attendanceid, driverid, {
    from: ATTENDANCE_STATUS.BOARDED,  //BOARDED
    to: ATTENDANCE_STATUS.DROPPED_OFF,  //DROPPED_OFF
    tsColumn: 'afternoon_dropped_off_at',
  });
}

async function completeAfternoonRoute(routeid, driverid) {
  return withTransaction(async (client) => {
    const { rows: routeRows } = await client.query(
      `SELECT id, driverid, afternoon_status
         FROM routes
        WHERE id = $1
        FOR UPDATE`,
      [routeid]
    );
    if (routeRows.length === 0) throw httpError(404, 'Route not found');

    const route = routeRows[0];
    if (route.driverid !== driverid) {
      throw httpError(403, 'Driver not assigned to this route');
    }
    if (route.afternoon_status !== ROUTE_STATUS.IN_PROGRESS) {
      throw httpError(409, `Afternoon route is ${route.afternoon_status}, cannot complete`);
    }

    const { rows: updRows } = await client.query(
      `UPDATE routes
          SET afternoon_status = $2,
              afternoon_completed_at = now()
        WHERE id = $1
      RETURNING afternoon_completed_at`,
      [routeid, ROUTE_STATUS.COMPLETED]
    );

    const today = `(now() AT TIME ZONE $2)::date`;

    // Still BOARDED -> DROPPED_OFF (keep an earlier dropoff time if one exists)
    await client.query(
      `UPDATE attendance
          SET afternoon_status = $3,
              afternoon_dropped_off_at = COALESCE(afternoon_dropped_off_at, now())
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND afternoon_status = $4`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.DROPPED_OFF, ATTENDANCE_STATUS.BOARDED]
    );

    // Never-boarded WAITING -> ABSENT (no ride home)
    await client.query(
      `UPDATE attendance
          SET afternoon_status = $3
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND afternoon_status = $4`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.ABSENT, ATTENDANCE_STATUS.WAITING]
    );

    const { rows: finalStudents } = await client.query(
      `SELECT a.id AS attendanceid, a.studentid AS id,
              s.first_name,
              a.morning_status, a.afternoon_status
         FROM attendance a
         JOIN students s ON s.id = a.studentid
        WHERE a.routeid = $1
          AND a.attendance_date = ${today}
        ORDER BY s.id`,
      [routeid, SCHOOL_TZ]
    );

    const summary = {
      total_students: finalStudents.length,
      dropped_off: finalStudents.filter((s) => s.afternoon_status === ATTENDANCE_STATUS.DROPPED_OFF).length,
      absent: finalStudents.filter((s) => s.afternoon_status === ATTENDANCE_STATUS.ABSENT).length,
    };

    return {
      routeid: routeid,
      completed_at: updRows[0].afternoon_completed_at,
      summary,
      students: finalStudents,
    };
  });
}

module.exports = {
    startMorningRoute,
    boardMorning,
    absentMorning,
    completeMorningRoute,
    startAfternoonRoute,
    boardAfternoon,
    dropoffAfternoon,
    completeAfternoonRoute,
    absentAfternoon
}