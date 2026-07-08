const db = require("../storage/AttendanceQuery.js");
const { getIO } = require("../sockets/socketHandler.js");
const { httpError } = require("../utils/functions.js");
const { SOCKET_EVENT } = require("../utils/enum.js");

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