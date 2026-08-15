const db = require("../storage/AttendanceQuery.js");
const { getIO } = require("../sockets/socketHandler.js");
const { httpError } = require("../utils/functions.js");
const { SOCKET_EVENT, ATTENDANCE_STATUS } = require("../utils/enum.js");
const { notify, notifyRoute } = require("../utils/push.js");

/*
    PUSH NOTIFICATIONS

    Every send below sits beside the socket broadcast it mirrors, inside the
    same `if (result.changed)` guard. That guard is doing real work: a driver
    double-tapping Board returns changed:false without touching the database,
    so the parent gets one notification rather than two.

    The sends are not awaited on purpose - see utils/push.js. The attendance
    row is already committed and the socket event is already out; FCM's latency
    belongs to nobody's request.

    A student with no parent attached produces parentid: null, which notify()
    discards. Nothing is sent and nothing fails.
*/

//The invisible half of a push, which the app reads to route the tap. Every
//value must be a string by the time it reaches FCM; utils/push.js converts.
function studentEvent(result, phase) {
    return {
        type: "attendance_updated",
        routeid: result.routeid,
        studentid: result.studentid,
        attendanceid: result.attendanceid,
        phase: phase,
        new_status: result.new_status
    };
}

exports.startMorning = async (req, res, next) => {
    try {
        const routeid = Number(req.params.routeid);
        if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');

        const driverid = req.user.userid;
        const { route, students } = await db.startMorningRoute(routeid, driverid);

        // Broadcast to the route room ONLY (drivers/parents/admin watching route N).
        getIO().to(`route:${routeid}`).emit(SOCKET_EVENT.ATTENDANCE_MORNING_START, {
            routeid: routeid,
            students,
        });

        notifyRoute(routeid, {
            kind: "run_started_morning",
            data: { type: "run_started", routeid: routeid, phase: "morning" }
        });

        res.json({ route, students });
    } catch (err) {
        console.log("Server Error (startMorning): " + err);
        next(err);
    }
}

exports.boardMorningStudent = async (req, res, next) => {
    try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, "Invalid attendanceid");

      const driverid = req.user.userid;
      const result = await db.boardMorning(attendanceid, driverid);

      // Broadcast only on a real state change -> no duplicate events on re-tap.
      if (result.changed) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, {
          attendanceid: result.attendanceid,
          phase: "morning",
          old_status: result.old_status,
          new_status: result.new_status,
          boarded_at: result.boarded_at,
        });

        notify([result.parentid], {
          kind: "boarded_morning",
          name: result.student_name,
          data: studentEvent(result, "morning")
        });
      }

      res.json(result);
    } catch (err) {
      console.log("Server Error (boardMorningStudent): " + err)
      next(err);
    }
}

exports.absentMorningStudent = async (req, res, next) => {
  try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, "Invalid attendanceid");

      const driverid = req.user.userid;
      const result = await db.absentMorning(attendanceid, driverid);

      // Broadcast only on a real state change -> no duplicate events on re-tap.
      if (result.changed) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, {
          attendanceid: result.attendanceid,
          phase: "morning",
          old_status: result.old_status,
          new_status: result.new_status,
        });

        notify([result.parentid], {
          kind: "absent_morning",
          name: result.student_name,
          data: studentEvent(result, "morning")
        });
      }

      res.json(result);
    } catch (err) {
      console.log("Server Error (absentMorningStudent): " + err)
      next(err);
    }
}

exports.completeMorning = async (req, res, next) => {
  try {
    const routeid = Number(req.params.routeid);
    if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');

    const driverid = req.user.userid;
    const result = await db.completeMorningRoute(routeid, driverid);

    getIO().to(`route:${routeid}`).emit(SOCKET_EVENT.ATTENDANCE_MORNING_COMPLETE, {
      routeid: routeid,
      completed_at: result.completed_at,
      summary: result.summary,
      students: result.students, // final ARRIVED/ABSENT states for live update
    });

    /*
        Completing the morning is where two things are decided for every child
        at once - who arrived, and who never showed up - so both notifications
        are sent from this roster rather than from a per-student event that
        does not exist.

        Each parent gets exactly one of them, or none:

          ARRIVED      -> "Arrived at school"
          auto_absent  -> "Marked absent", because this call marked them and
                          nobody has told the parent yet
          ABSENT       -> nothing; the driver marked them during the run and
                          that already sent a notification

        This replaces a generic "the morning trip is complete" to the whole
        route rather than joining it: two notifications a second apart saying
        overlapping things is worse than one that names the child.
    */
    for (const student of result.students) {
      const kind = student.status === ATTENDANCE_STATUS.ARRIVED ? "arrived_school"
        : student.auto_absent ? "absent_morning"
        : null;

      if (!kind) continue;

      notify([student.parentid], {
        kind: kind,
        name: student.first_name,
        data: {
          type: "attendance_updated",
          routeid: routeid,
          studentid: student.id,
          attendanceid: student.attendanceid,
          phase: "morning",
          new_status: student.status
        }
      });
    }

    res.json(result);
  } catch (err) {
    console.log("Server Error (completeMorning): " + err);
    next(err);
  }
}

exports.startAfternoon = async (req, res, next) => {
  try {
    const routeid = Number(req.params.routeid);
    if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');

    const driverid = req.user.userid;
    const { route, students } = await db.startAfternoonRoute(routeid, driverid);

    getIO().to(`route:${routeid}`).emit(SOCKET_EVENT.ATTENDANCE_AFTERNOON_START, {
      routeid: routeid,
      phase: 'afternoon',
      students,
    });

    notifyRoute(routeid, {
      kind: "run_started_afternoon",
      data: { type: "run_started", routeid: routeid, phase: "afternoon" }
    });

    res.json({ route, students });
  } catch (err) {
    console.log("Server Error (startAfternoon): " + err);
    next(err);
  }
}

exports.boardAfternoonStudent = async (req, res, next) => {
  try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, 'Invalid attendanceid');

      const result = await db.boardAfternoon(attendanceid, req.user.userid);

      if (result.changed) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, { //attendance:updated
          attendanceid: result.attendanceid,
          phase: 'afternoon',
          old_status: result.old_status,
          new_status: result.new_status,
          boarded_at: result.at,
        });

        notify([result.parentid], {
          kind: "boarded_afternoon",
          name: result.student_name,
          data: studentEvent(result, "afternoon")
        });
      }

      res.json(result);
    } catch (err) {
      console.log("Server Error (boardAfternoonStudent): " + err);
      next(err);
    }
}

exports.absentAfternoonStudent = async (req, res, next) => {
    try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, "Invalid attendanceid");

      const driverid = req.user.userid;
      const result = await db.absentAfternoon(attendanceid, driverid);

      // Broadcast only on a real state change -> no duplicate events on re-tap.
      if (result.changed) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, {
          attendanceid: result.attendanceid,
          phase: "afternoon",
          old_status: result.old_status,
          new_status: result.new_status,
        });

        notify([result.parentid], {
          kind: "absent_afternoon",
          name: result.student_name,
          data: studentEvent(result, "afternoon")
        });
      }

      res.json(result);
    } catch (err) {
      console.log("Server Error (absentAfternoonStudent): " + err)
      next(err);
    }
}

exports.dropoffAfternoonStudent = async (req, res, next) => {
  try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, 'Invalid attendanceid');

      const result = await db.dropoffAfternoon(attendanceid, req.user.userid);

      if (result.changed) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, { //attendance:updated
          attendanceid: result.attendanceid,
          phase: 'afternoon',
          old_status: result.old_status,
          new_status: result.new_status,
          dropped_off_at: result.at,
        });

        notify([result.parentid], {
          kind: "dropped_off",
          name: result.student_name,
          data: studentEvent(result, "afternoon")
        });
      }

      res.json(result);
    } catch (err) {
      console.log("Server Error (dropoffAfternoonStudent): " + err);
      next(err);
    }
}

exports.completeAfternoon = async (req, res, next) => {
  try {
    const routeid = Number(req.params.routeid);
    if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');

    const driverid = req.user.userid;
    const result = await db.completeAfternoonRoute(routeid, driverid);

    getIO().to(`route:${routeid}`).emit(SOCKET_EVENT.ATTENDANCE_AFTERNOON_COMPLETE, {  //route:afternoon_completed
      routeid: routeid,
      completed_at: result.completed_at,
      summary: result.summary,
      students: result.students,
    });

    /*
        The afternoon ends with one notification per parent, never two.

          auto_dropped_off -> "Dropped off". This call dropped them off, so
                              nobody has told the parent. A driver who tapped
                              Dropoff during the run already sent this, and
                              those parents get nothing further.
          not DROPPED_OFF  -> "The afternoon trip is complete". Their child did
                              not ride home, so a dropoff message would be
                              wrong, but the run finishing still concerns them.

        A parent who has just been told their child is home does not also need
        telling the bus is done, which is why the run-complete message is aimed
        rather than broadcast to the route.
    */
    for (const student of result.students) {
      if (!student.auto_dropped_off) continue;

      notify([student.parentid], {
        kind: "dropped_off",
        name: student.first_name,
        data: {
          type: "attendance_updated",
          routeid: routeid,
          studentid: student.id,
          attendanceid: student.attendanceid,
          phase: "afternoon",
          new_status: student.afternoon_status
        }
      });
    }

    notifyRoute(routeid, {
      kind: "run_completed_afternoon",
      data: { type: "run_completed", routeid: routeid, phase: "afternoon" },
      only: result.students
        .filter((student) => student.afternoon_status !== ATTENDANCE_STATUS.DROPPED_OFF)
        .map((student) => student.parentid)
    });

    res.json(result);
  } catch (err) {
    console.log("Server Error (completeAfternoon): " + err);
    next(err);
  }
}

//ADMIN STUFF HERE

exports.adminOverride = async (req, res, next) => {
  try {
      const attendanceid = Number(req.params.attendanceid);
      if (!Number.isInteger(attendanceid)) throw httpError(400, 'Invalid attendanceid');
  
      // Derive phase from whichever status key is present.
      let phase, status;
      if (req.body.afternoon_status !== undefined) {
        phase = 'afternoon';
        status = req.body.afternoon_status;
      } else if (req.body.morning_status !== undefined) {
        phase = 'morning';
        status = req.body.morning_status;
      } else {
        throw httpError(400, 'Provide morning_status or afternoon_status');
      }
  
      const admin = req.user; // { id, role }
      const result = await db.adminOverrideAttendance(attendanceid, admin, phase, status);
      if (result.changed && result.should_broadcast) {
        getIO().to(`route:${result.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_ADMIN_OVERRIDE, {
          attendanceid: result.attendanceid,
          phase: result.phase,
          old_status: result.old_status,
          new_status: result.new_status,
          changed_at: result.changed_at,
        });
      }
  
      res.json(result);
    } catch (err) {
      console.log("Server Error (adminOverride): " + err);
      next(err);
    }
}

//gets the attendance in the provided date
exports.routeAttendance = async (req, res, next) => {
  try {
      const routeid = Number(req.params.routeid);
      const { date } = req.body;
      if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');
      if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "date must be provided as YYYY-MM-DD")

      const students = await db.getAttendance(routeid, date);
      res.json({ routeid: routeid, students });
    } catch (err) {
      console.log("Server Error (routeAttendance): " + err);
      next(err);
    }
}

//MVP
exports.restartTrip = async (req, res, next) => {
  try {
    const routeid = Number(req.params.routeid);
    if (!Number.isInteger(routeid)) throw httpError(400, 'Invalid routeid');
    await db.restartTrip(routeid);

    res.json({message: "Done!"});
  } catch (err) {
    console.log("Server Error (restartTrip): " + err);
    next(err);
  }
}