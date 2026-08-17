const db = require("../storage/AttendanceQuery.js");
const { getIO } = require("../sockets/socketHandler.js");
const { httpError } = require("../utils/functions.js");
const { SOCKET_EVENT, ATTENDANCE_STATUS } = require("../utils/enum.js");
const {
  readDatePage,
  readDateIdPage,
  dateIdCursor,
  readDateFilter,
  readIdFilter,
  buildPage
} = require("../utils/pagination.js");
const { toWorkbookBuffer, XLSX_CONTENT_TYPE } = require("../utils/xlsx.js");
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
/*
    One student's attendance history, newest day first, paged.

    ?from= ?to=  an inclusive date range, either end optional

    The range is applied here rather than over the loaded rows in the browser
    for the same reason the students filters are: the list is paged, so a filter
    on the client would only ever narrow the days that had been scrolled to and
    would show nothing at all for a month further back than that.

    The student themself is only sent with the first page - the client keeps it
    while scrolling, so re-selecting the same unchanged row for every page would
    be paying for an answer we already have. Same reasoning as `total` on the
    other paged lists.

    A student who exists but has never been on a run is a 200 with an empty
    list, not a 404: there is nothing wrong, they simply have no history yet.
    Only an id matching no student at all is missing.
*/
function readStudentFilters(req) {
  const studentid = Number(req.params.studentid);
  if (!Number.isInteger(studentid)) throw httpError(400, 'Invalid studentid');

  return {
    studentid: studentid,
    from: readDateFilter(req.query.from, "from"),
    to: readDateFilter(req.query.to, "to")
  };
}

exports.studentAttendance = async (req, res, next) => {
  try {
      const filters = readStudentFilters(req);
      const { limit, cursor } = readDatePage(req.query);

      const student = cursor === null ? await db.getStudentSummary(filters.studentid) : undefined;
      if (student === null) throw httpError(404, "Student not found");

      const rows = await db.getStudentAttendancePage({ ...filters, cursor, limit });
      //Paged by date, so the cursor is the date - not the row id.
      const page = buildPage(rows, limit, "attendance_date");
      //Only on the first page: later pages do not change what is in scope, and
      //the client keeps the number it was given.
      const total = cursor === null ? await db.countStudentAttendance(filters) : undefined;

      res.json({
        attendance: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        student: student,
        total: total
      });
    } catch (err) {
      console.log("Server Error (studentAttendance): " + err);
      next(err);
    }
}

/*
    The same history as a spreadsheet.

    The date range is respected, so with no dates set this is the child's
    complete history and with them it is whatever the page was showing - but it
    is never only the pages that happen to have been scrolled to.

    Every column the table shows plus the student it belongs to on each row, so
    a file that ends up merged with another export still says whose it is.

    The types are what make it a spreadsheet rather than a grid of text: the
    date column sorts and filters as dates, and the four times as times.
*/
const EXPORT_COLUMNS = [
  { key: "student_name", header: "Student" },
  { key: "parent_name", header: "Parent" },
  { key: "attendance_date", header: "Date", type: "date" },
  { key: "route_name", header: "Route" },
  { key: "morning_status", header: "Morning status" },
  //Named as times because that is what they are — the day is the Date column.
  { key: "morning_boarded_at", header: "Morning boarded time", type: "time" },
  { key: "morning_arrived_at", header: "Morning arrived time", type: "time" },
  { key: "afternoon_status", header: "Afternoon status" },
  { key: "afternoon_boarded_at", header: "Afternoon boarded time", type: "time" },
  { key: "afternoon_dropped_off_at", header: "Afternoon dropped off time", type: "time" }
];

exports.studentAttendanceExport = async (req, res, next) => {
  try {
      const filters = readStudentFilters(req);

      const student = await db.getStudentSummary(filters.studentid);
      if (!student) throw httpError(404, "Student not found");

      const rows = await db.getStudentAttendanceAll(filters);

      const buffer = await toWorkbookBuffer({
        sheetName: "Attendance",
        columns: EXPORT_COLUMNS,
        rows: rows.map((row) => ({
          ...row,
          student_name: student.first_name,
          parent_name: student.parent_name
        }))
      });

      /*
          A filename is set even though the browser download is driven by the
          client: anything else fetching this - curl, a scheduled job - gets a
          sensible name instead of "student".

          The range is in it so two exports of the same child do not overwrite
          each other in a downloads folder, the same as the school's.
      */
      const range = filters.from || filters.to
        ? `-${filters.from ?? "start"}_${filters.to ?? "end"}`
        : "";

      res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="attendance-${filters.studentid}${range}.xlsx"`);
      res.send(buffer);
    } catch (err) {
      console.log("Server Error (studentAttendanceExport): " + err);
      next(err);
    }
}

/* ---------------------------------------------------------------------------
   ONE SCHOOL'S ATTENDANCE

   ?routeid=  narrows to one route, absent means every route
   ?from= ?to=  an inclusive date range, either end optional
--------------------------------------------------------------------------- */
function readSchoolFilters(req) {
  const schoolid = Number(req.params.schoolid);
  if (!Number.isInteger(schoolid)) throw httpError(400, 'Invalid schoolid');

  return {
    schoolid: schoolid,
    from: readDateFilter(req.query.from, "from"),
    to: readDateFilter(req.query.to, "to")
  };
}

exports.schoolAttendance = async (req, res, next) => {
  try {
      const filters = readSchoolFilters(req);
      const routeid = readIdFilter(req.query.routeid, "route");
      const { limit, cursor } = readDateIdPage(req.query);

      //'none' is meaningless here: an attendance row always belongs to the run
      //that created it, so there is no such thing as one without a route.
      if (routeid === 'none') throw httpError(400, "Invalid route");

      const scoped = { ...filters, routeid: routeid };

      const rows = await db.getSchoolAttendancePage({ ...scoped, cursor, limit });
      //Many rows share a date, so the position is the date and the id together.
      const page = buildPage(rows, limit, dateIdCursor);
      const total = cursor === null ? await db.countSchoolAttendance(scoped) : undefined;

      res.json({
        attendance: page.items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        total: total
      });
    } catch (err) {
      console.log("Server Error (schoolAttendance): " + err);
      next(err);
    }
}

const SCHOOL_EXPORT_COLUMNS = [
  { key: "attendance_date", header: "Date", type: "date" },
  { key: "student_name", header: "Student" },
  { key: "parent_name", header: "Parent" },
  { key: "route_name", header: "Route" },
  { key: "morning_status", header: "Morning status" },
  { key: "morning_boarded_at", header: "Morning boarded time", type: "time" },
  { key: "morning_arrived_at", header: "Morning arrived time", type: "time" },
  { key: "afternoon_status", header: "Afternoon status" },
  { key: "afternoon_boarded_at", header: "Afternoon boarded time", type: "time" },
  { key: "afternoon_dropped_off_at", header: "Afternoon dropped off time", type: "time" }
];

/*
    The school's attendance as a spreadsheet.

    Every route, always — the route filter on the page narrows what is being
    read, not what is exported. The date range is respected, so with no dates
    set this is the school's complete history and with them it is a term or a
    month.
*/
exports.schoolAttendanceExport = async (req, res, next) => {
  try {
      const filters = readSchoolFilters(req);

      const school = await db.getSchoolName(filters.schoolid);
      if (!school) throw httpError(404, "School not found");

      const rows = await db.getSchoolAttendanceAll(filters);

      const buffer = await toWorkbookBuffer({
        sheetName: "Attendance",
        columns: SCHOOL_EXPORT_COLUMNS,
        rows: rows
      });

      //The range is in the filename so two exports of the same school do not
      //overwrite each other in a downloads folder.
      const range = filters.from || filters.to
        ? `-${filters.from ?? "start"}_${filters.to ?? "end"}`
        : "";

      res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="attendance-school-${school.id}${range}.xlsx"`);
      res.send(buffer);
    } catch (err) {
      console.log("Server Error (schoolAttendanceExport): " + err);
      next(err);
    }
}

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