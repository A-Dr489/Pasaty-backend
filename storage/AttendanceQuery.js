// require("dotenv").config();
const pool = require("./pool.js");
const { httpError } = require('../utils/functions.js');
const { whereClause } = require("../utils/pagination.js");
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
      /*
         students is joined for the push notification: the parent to notify and
         the name to put in it. LEFT, not inner - attendance.studentid is
         nullable, and an inner join would return no rows for such a row, which
         the guard below turns into a 404. A missing push target must not stop a
         driver marking a child.

         It costs no extra lock: FOR UPDATE OF a locks attendance only.
      */
      `SELECT a.id, a.routeid, a.afternoon_status, a.studentid,
              a.${tsColumn} AS current_at,
              r.driverid, r.afternoon_status AS route_afternoon_status,
              s.first_name AS student_name, s.parentid
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
         LEFT JOIN students s ON s.id = a.studentid
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
        studentid: row.studentid,
        student_name: row.student_name,
        parentid: row.parentid,
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
      studentid: row.studentid,
      student_name: row.student_name,
      parentid: row.parentid,
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
            `SELECT id, driverid, morning_status, morning_started_at, morning_completed_at,
                    (COALESCE(morning_completed_at, morning_started_at) AT TIME ZONE $2)::date
                      = (now() AT TIME ZONE $2)::date AS morning_is_today
               FROM routes
              WHERE id = $1
              FOR UPDATE`,
            [routeid, SCHOOL_TZ]
        );
        if (routeRows.length === 0) throw httpError(404, 'Route not found');
        const route = routeRows[0];
        if (route.driverid !== driverid) {
            throw httpError(403, 'Driver not assigned to this route');
        }
        const statusBelongsToToday = route.morning_is_today === true;
        if(route.morning_status === ROUTE_STATUS.IN_PROGRESS && statusBelongsToToday) {
          const { rows: students } = await client.query(
            `SELECT a.id AS attendanceid, a.studentid AS id,
                    s.first_name, a.morning_status AS status,
                    CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
                    w.sort_number AS sort_number
                FROM attendance a
                JOIN students s ON s.id = a.studentid
                JOIN users p ON p.id = s.parentid
                JOIN waypoints w ON w.studentid = s.id
                WHERE a.routeid = $1
                AND a.attendance_date = (now() AT TIME ZONE $2)::date
                ORDER BY w.sort_number`,
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

        const startable = STARTABLE.includes(route.morning_status) || !statusBelongsToToday;
        if (!startable) {
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
                s.first_name, a.morning_status AS status,
                CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
                w.sort_number AS sort_number
            FROM attendance a
            JOIN students s ON s.id = a.studentid
            JOIN users p ON p.id = s.parentid
            JOIN waypoints w ON w.studentid = s.id
            WHERE a.routeid = $1
            AND a.attendance_date = (now() AT TIME ZONE $2)::date
            ORDER BY w.sort_number`,
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
      //LEFT JOIN students for the push target and the child's name — see
      //afternoonTransition for why it must not be an inner join.
      `SELECT a.id, a.routeid, a.morning_status, a.studentid,
              r.driverid, r.morning_status AS route_morning_status,
              a.morning_boarded_at,
              s.first_name AS student_name, s.parentid
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
         LEFT JOIN students s ON s.id = a.studentid
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
        studentid: row.studentid,
        student_name: row.student_name,
        parentid: row.parentid,
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
      studentid: row.studentid,
      student_name: row.student_name,
      parentid: row.parentid,
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
      //LEFT JOIN students for the push target and the child's name — see
      //afternoonTransition for why it must not be an inner join.
      `SELECT a.id, a.routeid, a.morning_status, a.studentid,
              r.driverid, r.morning_status AS route_morning_status,
              a.morning_boarded_at,
              s.first_name AS student_name, s.parentid
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
         LEFT JOIN students s ON s.id = a.studentid
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
        studentid: row.studentid,
        student_name: row.student_name,
        parentid: row.parentid,
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
      studentid: row.studentid,
      student_name: row.student_name,
      parentid: row.parentid,
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
      RETURNING morning_started_at, morning_completed_at, morning_completed_at - morning_started_at AS trip_duration`,
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

    /*
        Never-boarded WAITING -> ABSENT.

        RETURNING because these are the only absences nobody has been told
        about: a child the driver marked absent had that pushed at the time,
        while these are decided here, in bulk, at the end of the run. Without
        knowing which rows this statement changed, the two are
        indistinguishable afterwards - both are simply ABSENT with no boarding
        time - and notifying every ABSENT child would push a second, duplicate
        notification to the parents the driver had already told.
    */
    const { rows: autoAbsent } = await client.query(
      `UPDATE attendance
          SET morning_status = $3
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND morning_status = $4
      RETURNING id`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.ABSENT, ATTENDANCE_STATUS.WAITING]
    );
    const autoAbsentIds = new Set(autoAbsent.map((row) => row.id));

    const { rows: finalStudents } = await client.query(
      //parentid is here for the "arrived at school" push: this is the only
      //place a child's arrival is decided, and it happens in bulk rather than
      //per student, so the notification is sent from this roster.
      `SELECT a.id AS attendanceid, a.studentid AS id,
              s.first_name, a.morning_status AS status,
              s.parentid,
              CONCAT(p.first_name, ' ', p.last_name) AS parent_name
         FROM attendance a
         JOIN students s ON s.id = a.studentid
         JOIN users p ON p.id = s.parentid
        WHERE a.routeid = $1
          AND a.attendance_date = ${today}
        ORDER BY s.id`,
      [routeid, SCHOOL_TZ]
    );

    //auto_absent marks the children this call marked absent, as opposed to the
    //ones the driver marked during the run. Only the former still need telling.
    const students = finalStudents.map((student) => ({
      ...student,
      auto_absent: autoAbsentIds.has(student.attendanceid),
    }));

    const summary = {
      total_students: students.length,
      arrived: students.filter((s) => s.status === ATTENDANCE_STATUS.ARRIVED).length,
      absent: students.filter((s) => s.status === ATTENDANCE_STATUS.ABSENT).length,
      trip_duration: updRows[0].trip_duration
    };

    return {
      routeid: routeid,
      started_at: updRows[0].morning_started_at,
      completed_at: updRows[0].morning_completed_at,
      summary,
      students,
    };
  });
}

async function startAfternoonRoute(routeid, driverid) {
  return withTransaction(async (client) => {
    const { rows: routeRows } = await client.query(
        `SELECT id, driverid, morning_status, afternoon_status, afternoon_started_at, afternoon_completed_at,
                (COALESCE(afternoon_completed_at, afternoon_started_at) AT TIME ZONE $2)::date
                  = (now() AT TIME ZONE $2)::date AS afternoon_is_today
            FROM routes
          WHERE id = $1
          FOR UPDATE`,
        [routeid, SCHOOL_TZ]
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
    const statusBelongsToToday = route.afternoon_is_today === true;
    if(route.afternoon_status === ROUTE_STATUS.IN_PROGRESS && statusBelongsToToday) {
          const { rows: students } = await client.query(
            `SELECT a.id AS attendanceid, a.studentid AS id,
                    s.first_name,
                    CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
                    a.morning_status, a.afternoon_status
              FROM attendance a
              JOIN students s ON s.id = a.studentid
              JOIN users p ON p.id = s.parentid
              WHERE a.routeid = $1
                AND a.attendance_date = ${today}
              ORDER BY s.id`,
            [routeid, SCHOOL_TZ]
          );
          return {
            route: {
              id: routeid,
              afternoon_status: route.afternoon_status,
              afternoon_started_at: route.afternoon_started_at,
            },
            students,
          }
        }
      const startable = STARTABLE.includes(route.afternoon_status) || !statusBelongsToToday;
    if (!startable) {
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
              CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
              a.morning_status, a.afternoon_status
         FROM attendance a
         JOIN students s ON s.id = a.studentid
         JOIN users p ON p.id = s.parentid
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
      //LEFT JOIN students for the push target and the child's name — see
      //afternoonTransition for why it must not be an inner join.
      `SELECT a.id, a.routeid, a.afternoon_status, a.studentid,
              r.driverid, r.afternoon_status AS route_afternoon_status,
              a.afternoon_boarded_at,
              s.first_name AS student_name, s.parentid
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
         LEFT JOIN students s ON s.id = a.studentid
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
        studentid: row.studentid,
        student_name: row.student_name,
        parentid: row.parentid,
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
      studentid: row.studentid,
      student_name: row.student_name,
      parentid: row.parentid,
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
      RETURNING afternoon_started_at, afternoon_completed_at, afternoon_completed_at - afternoon_started_at AS trip_duration`,
      [routeid, ROUTE_STATUS.COMPLETED]
    );

    const today = `(now() AT TIME ZONE $2)::date`;

    /*
        Still BOARDED -> DROPPED_OFF (keep an earlier dropoff time if one exists)

        RETURNING for the same reason as the morning's auto-absent: a child the
        driver dropped off had that pushed at the time, and a child dropped off
        by this statement has been told nothing. Afterwards both simply read
        DROPPED_OFF, so this is the only chance to tell them apart.
    */
    const { rows: autoDropped } = await client.query(
      `UPDATE attendance
          SET afternoon_status = $3,
              afternoon_dropped_off_at = COALESCE(afternoon_dropped_off_at, now())
        WHERE routeid = $1
          AND attendance_date = ${today}
          AND afternoon_status = $4
      RETURNING id`,
      [routeid, SCHOOL_TZ, ATTENDANCE_STATUS.DROPPED_OFF, ATTENDANCE_STATUS.BOARDED]
    );
    const autoDroppedIds = new Set(autoDropped.map((row) => row.id));

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
      //parentid is here so the completion notifications can be aimed: who gets
      //a dropoff, and who gets the run-complete instead.
      `SELECT a.id AS attendanceid, a.studentid AS id,
              s.first_name, s.parentid,
              CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
              a.morning_status, a.afternoon_status
         FROM attendance a
         JOIN students s ON s.id = a.studentid
         JOIN users p ON p.id = s.parentid
        WHERE a.routeid = $1
          AND a.attendance_date = ${today}
        ORDER BY s.id`,
      [routeid, SCHOOL_TZ]
    );

    //auto_dropped_off marks the children this call dropped off, as opposed to
    //the ones the driver dropped off during the run.
    const students = finalStudents.map((student) => ({
      ...student,
      auto_dropped_off: autoDroppedIds.has(student.attendanceid),
    }));

    const summary = {
      total_students: students.length,
      dropped_off: students.filter((s) => s.afternoon_status === ATTENDANCE_STATUS.DROPPED_OFF).length,
      absent: students.filter((s) => s.afternoon_status === ATTENDANCE_STATUS.ABSENT).length,
      trip_duration: updRows[0].trip_duration
    };

    return {
      routeid: routeid,
      started_at: updRows[0].afternoon_started_at,
      completed_at: updRows[0].afternoon_completed_at,
      summary,
      students,
    };
  });
}

const PHASE_STATUSES = {
  morning: ['WAITING', 'BOARDED', 'ARRIVED', 'ABSENT'],
  afternoon: ['WAITING', 'BOARDED', 'DROPPED_OFF', 'ABSENT'],
};

const STATUS_TS_COLUMN = {
  morning: { BOARDED: 'morning_boarded_at', ARRIVED: 'morning_arrived_at' },
  afternoon: { BOARDED: 'afternoon_boarded_at', DROPPED_OFF: 'afternoon_dropped_off_at' },
};

//ADMIN STUFF UNDER HERE

async function adminOverrideAttendance(attendanceid, admin, phase, status) {
  const allowed = PHASE_STATUSES[phase];
  if (!allowed) throw httpError(400, `Invalid phase ${phase}`);
  if (!allowed.includes(status)) {
    throw httpError(400, `Invalid ${phase} status ${status}`);
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT a.id, a.routeid, a.morning_status, a.afternoon_status,
              r.morning_status   AS route_morning_status,
              r.afternoon_status AS route_afternoon_status,
              (a.attendance_date = (now() AT TIME ZONE $2)::date) AS is_today
         FROM attendance a
         JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [attendanceid, SCHOOL_TZ]
    );
    if (rows.length === 0) throw httpError(404, 'Attendance not found');

    const row = rows[0];
    const statusCol = `${phase}_status`;
    const oldStatus = row[statusCol];

    const routePhaseStatus = phase === 'morning'
      ? row.route_morning_status
      : row.route_afternoon_status;
    const shouldBroadcast = row.is_today && routePhaseStatus === ROUTE_STATUS.IN_PROGRESS;


    if (oldStatus === status) {
      return { 
        changed: false, attendanceid: row.id, routeid: row.routeid,
        phase, old_status: oldStatus, new_status: status,
        should_broadcast: false 
      };
    }

    // Stamp the matching timestamp column when the new status has one.
    const tsCol = STATUS_TS_COLUMN[phase][status];
    const tsAssign = tsCol ? `, ${tsCol} = now()` : '';

    const { rows: upd } = await client.query(
      `UPDATE attendance
          SET ${statusCol} = $2,
              updated_by = $3,
              updated_at = now()
              ${tsAssign}
        WHERE id = $1
      RETURNING updated_at`,
      [attendanceid, status, admin.userid]
    );

    await client.query(
      `INSERT INTO attendance_audit
         (attendanceid, phase, old_status, new_status, changed_by, changed_by_role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [attendanceid, phase, oldStatus, status, admin.userid, admin.role]
    );

    return {
      changed: true,
      attendanceid: row.id,
      routeid: row.routeid,
      phase,
      old_status: oldStatus,
      new_status: status,
      changed_at: upd[0].updated_at,
      should_broadcast: shouldBroadcast,
    };
  });
}

async function getAttendance(routeid, date) {
  const { rows } = await pool.query(
    `SELECT a.id AS attendanceid, a.studentid AS id,
            s.first_name,
            CONCAT(p.first_name, ' ', p.last_name) AS parent_name,
            a.morning_status, a.afternoon_status
       FROM attendance a
       JOIN students s ON s.id = a.studentid
       JOIN users p ON p.id = s.parentid
      WHERE a.routeid = $1
        AND a.attendance_date = $2::date
      ORDER BY s.id`,
    [routeid, date]
  );
  return rows;
}

//MVP
/* ---------------------------------------------------------------------------
   ONE STUDENT'S HISTORY

   The admin portal's per-student view: every day this child has an attendance
   row for, newest first, paged by date.
--------------------------------------------------------------------------- */

/*
    Who the history belongs to, for the page header and for handing the name to
    the register's search box.

    LEFT JOINs throughout: parentid, routeid and schoolid are all nullable, and
    a student missing any of them still has attendance worth looking at.

    No row count here. It used to carry one, but the history can now be narrowed
    to a date range and a total that ignored the range would contradict the rows
    under it. countStudentAttendance answers it under the same filters the page
    was read with, so there is only one place the number comes from.
*/
async function getStudentSummary(studentid) {
    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.routeid,
               CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
               r.name AS route_name
        FROM students s
        LEFT JOIN users u ON u.id = s.parentid
        LEFT JOIN routes r ON r.id = s.routeid
        WHERE s.id = $1
    `, [studentid]);

    return rows[0] ?? null;
}

/*
    The student and an optional date range, shared by the page, the count and
    the export so the three can never disagree about what is in scope.

    startAt is where this query has already used up parameter positions - the
    two that format times have taken $1 before these are numbered.
*/
function studentAttendanceFilters(studentid, from, to, startAt = 0) {
    const values = [];
    const where = [];
    const at = () => startAt + values.length;

    values.push(studentid);
    where.push(`a.studentid = $${at()}`);

    //Inclusive at both ends, the same as the school view: an admin asking for
    //the 1st to the 30th means the 30th to be in it.
    if(from) {
        values.push(from);
        where.push(`a.attendance_date >= $${at()}::date`);
    }

    if(to) {
        values.push(to);
        where.push(`a.attendance_date <= $${at()}::date`);
    }

    return { where, values };
}

/*
    One page of that history.

    attendance_date is formatted in postgres rather than handed over as a date
    object. node-pg turns a `date` column into a JS Date at local midnight, and
    serialising that to JSON can shift it across a day boundary - which would
    both mislabel the row and corrupt the cursor, since the cursor IS the date.
    As a string it means the same day everywhere.

    routeid comes from the attendance row, not from the student. A child may be
    moved to another route, and the register for an old day belongs to the route
    that actually drove it.
*/
/*
    The four moments a run stamps on a student, as clock times.

    Rendered in the school's timezone rather than handed over raw, for the same
    reason attendance_date is: the day these times belong to was decided in
    SCHOOL_TZ, so showing them in the reader's timezone could put a boarding at
    23:40 on the row labelled the following morning. Formatting here keeps the
    time and the date it sits beside describing the same instant.

    A null stays null — an absent child was never boarded, and 00:00 would be a
    lie rather than a blank.
*/
const PHASE_TIMES = `
    to_char(a.morning_boarded_at AT TIME ZONE $TZ, 'HH24:MI') AS morning_boarded_at,
    to_char(a.morning_arrived_at AT TIME ZONE $TZ, 'HH24:MI') AS morning_arrived_at,
    to_char(a.afternoon_boarded_at AT TIME ZONE $TZ, 'HH24:MI') AS afternoon_boarded_at,
    to_char(a.afternoon_dropped_off_at AT TIME ZONE $TZ, 'HH24:MI') AS afternoon_dropped_off_at
`;

async function getStudentAttendancePage({ studentid, from, to, cursor, limit }) {
    //SCHOOL_TZ takes $1 so the time formatting can be shared; the filters are
    //numbered from there.
    const values = [SCHOOL_TZ];
    const filters = studentAttendanceFilters(studentid, from, to, values.length);
    values.push(...filters.values);
    const where = filters.where;

    /*
        The cursor and the range are both bounds on the same column, and both
        are kept. The range says which days the admin asked for; the cursor says
        how far down them the reader has got. Dropping either one would either
        restart the list at every page or page outside the range.
    */
    if(cursor !== null) {
        values.push(cursor);
        where.push(`a.attendance_date < $${values.length}::date`);
    }

    values.push(limit + 1);

    const { rows } = await pool.query(`
        SELECT a.id, a.routeid,
               to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
               a.morning_status, a.afternoon_status,
               ${PHASE_TIMES.replaceAll('$TZ', '$1')},
               r.name AS route_name
        FROM attendance a
        LEFT JOIN routes r ON r.id = a.routeid
        ${whereClause(where)}
        ORDER BY a.attendance_date DESC
        LIMIT $${values.length}
    `, values);

    return rows;
}

//How many days are in scope, for the header. Counted under the same filters
//the page was read with, so the number and the rows always describe each other.
async function countStudentAttendance({ studentid, from, to }) {
    const { where, values } = studentAttendanceFilters(studentid, from, to);

    const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS total
        FROM attendance a
        ${whereClause(where)}
    `, values);

    return rows[0].total;
}

/*
    The same history with no paging, for the export.

    Deliberately not the paged query with a huge limit: an export that silently
    stopped at a page boundary would be worse than one that refused, and a
    student's row count is bounded by the number of school days they have
    attended.

    The date range is respected - what the file holds is what the page was
    showing - but there is no cursor: unpaged means every day in that range.

    Seconds are kept here where the table shows only hours and minutes — a
    spreadsheet is where someone goes to measure something.

    The four times carry no date of their own. Repeating the row's own date in
    every one of them made each cell wide enough that Excel could not fit it in
    a default column and showed ###### instead of a value — a file that looks
    broken on open. The date is already its own column, and every one of these
    is stamped during that day's run.
*/
async function getStudentAttendanceAll({ studentid, from, to }) {
    const values = [SCHOOL_TZ];
    const filters = studentAttendanceFilters(studentid, from, to, values.length);
    values.push(...filters.values);

    const { rows } = await pool.query(`
        SELECT to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
               a.routeid,
               r.name AS route_name,
               a.morning_status, a.afternoon_status,
               to_char(a.morning_boarded_at AT TIME ZONE $1, 'HH24:MI:SS') AS morning_boarded_at,
               to_char(a.morning_arrived_at AT TIME ZONE $1, 'HH24:MI:SS') AS morning_arrived_at,
               to_char(a.afternoon_boarded_at AT TIME ZONE $1, 'HH24:MI:SS') AS afternoon_boarded_at,
               to_char(a.afternoon_dropped_off_at AT TIME ZONE $1, 'HH24:MI:SS') AS afternoon_dropped_off_at
        FROM attendance a
        LEFT JOIN routes r ON r.id = a.routeid
        ${whereClause(filters.where)}
        ORDER BY a.attendance_date DESC
    `, values);

    return rows;
}

/* ---------------------------------------------------------------------------
   ONE SCHOOL'S ATTENDANCE

   Every child at a school, every day, newest first — optionally narrowed to one
   route and to a date range.

   The school comes from the STUDENT, not from the route. Routes carry a
   schoolid of their own, but attendance is a fact about a child, and a child
   belongs to the school they attend even on a day a different school's bus
   collected them.

   students is joined inner rather than left, which is not a loss here: the
   filter is on the student's school, so a row without a student could not match
   it under any join.
--------------------------------------------------------------------------- */
const SCHOOL_ATTENDANCE_FROM = `
    FROM attendance a
    JOIN students s ON s.id = a.studentid
    LEFT JOIN users u ON u.id = s.parentid
    LEFT JOIN routes r ON r.id = a.routeid
`;

function schoolAttendanceFilters(schoolid, routeid, from, to, startAt = 0) {
    const values = [];
    const where = [];
    const at = () => startAt + values.length;

    values.push(schoolid);
    where.push(`s.schoolid = $${at()}`);

    if(routeid !== null && routeid !== undefined) {
        values.push(routeid);
        where.push(`a.routeid = $${at()}`);
    }

    //Inclusive at both ends: an admin asking for the 1st to the 30th means the
    //30th to be in it.
    if(from) {
        values.push(from);
        where.push(`a.attendance_date >= $${at()}::date`);
    }

    if(to) {
        values.push(to);
        where.push(`a.attendance_date <= $${at()}::date`);
    }

    return { where, values };
}

async function getSchoolAttendancePage({ schoolid, routeid, from, to, cursor, limit }) {
    //SCHOOL_TZ takes $1 so the time formatting can be shared; the filters are
    //numbered from there.
    const values = [SCHOOL_TZ];
    const filters = schoolAttendanceFilters(schoolid, routeid, from, to, values.length);
    values.push(...filters.values);
    const where = filters.where;

    if(cursor !== null) {
        values.push(cursor.date, cursor.id);
        //Compared as a pair: the date decides, and the id breaks the ties that
        //a whole school's worth of rows on one day produces.
        where.push(`(a.attendance_date, a.id) < ($${values.length - 1}::date, $${values.length})`);
    }

    values.push(limit + 1);

    const { rows } = await pool.query(`
        SELECT a.id, a.routeid, a.studentid,
               to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
               a.morning_status, a.afternoon_status,
               ${PHASE_TIMES.replaceAll('$TZ', '$1')},
               s.first_name AS student_name,
               CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
               r.name AS route_name
        ${SCHOOL_ATTENDANCE_FROM}
        ${whereClause(where)}
        ORDER BY a.attendance_date DESC, a.id DESC
        LIMIT $${values.length}
    `, values);

    return rows;
}

async function countSchoolAttendance({ schoolid, routeid, from, to }) {
    const { where, values } = schoolAttendanceFilters(schoolid, routeid, from, to);

    const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS total
        ${SCHOOL_ATTENDANCE_FROM}
        ${whereClause(where)}
    `, values);

    return rows[0].total;
}

/*
    The same thing unpaged, for the export.

    routeid is deliberately absent from the signature rather than passed as
    null: the export is always every route, and a parameter that only ever holds
    one value invites somebody to pass the other one.
*/
async function getSchoolAttendanceAll({ schoolid, from, to }) {
    const values = [SCHOOL_TZ];
    const filters = schoolAttendanceFilters(schoolid, null, from, to, values.length);
    values.push(...filters.values);

    const { rows } = await pool.query(`
        SELECT to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
               s.first_name AS student_name,
               CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
               r.name AS route_name,
               a.morning_status, a.afternoon_status,
               to_char(a.morning_boarded_at AT TIME ZONE $1, 'HH24:MI:SS') AS morning_boarded_at,
               to_char(a.morning_arrived_at AT TIME ZONE $1, 'HH24:MI:SS') AS morning_arrived_at,
               to_char(a.afternoon_boarded_at AT TIME ZONE $1, 'HH24:MI:SS') AS afternoon_boarded_at,
               to_char(a.afternoon_dropped_off_at AT TIME ZONE $1, 'HH24:MI:SS') AS afternoon_dropped_off_at
        ${SCHOOL_ATTENDANCE_FROM}
        ${whereClause(filters.where)}
        ORDER BY a.attendance_date DESC, s.first_name
    `, values);

    return rows;
}

//The school's own name, for the export's filename and sheet.
async function getSchoolName(schoolid) {
    const { rows } = await pool.query("SELECT id, name FROM school WHERE id = $1", [schoolid]);
    return rows[0] ?? null;
}

async function restartTrip(routeid) {
  return withTransaction(async (client) => {
    await client.query("UPDATE routes SET morning_status = null, afternoon_status = null, morning_started_at = NULL, afternoon_started_at = NULL, morning_completed_at = NULL, afternoon_completed_at = NULL WHERE id = $1", [routeid]);
    await client.query("DELETE FROM attendance WHERE routeid = $1", [routeid]);
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
    absentAfternoon,
    adminOverrideAttendance,
    getAttendance,
    getStudentSummary,
    getStudentAttendancePage,
    countStudentAttendance,
    getStudentAttendanceAll,
    getSchoolAttendancePage,
    countSchoolAttendance,
    getSchoolAttendanceAll,
    getSchoolName,
    restartTrip
}