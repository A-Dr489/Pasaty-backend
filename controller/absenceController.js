const db = require("../storage/plannedAbsenceQuery.js");
const { httpError } = require("../utils/functions.js");
const { getIO } = require("../sockets/socketHandler.js");
const { SOCKET_EVENT, ROUTE_STATUS, ATTENDANCE_STATUS } = require("../utils/enum.js");
const { notifyNextUp } = require("./AttendanceController.js");

/* ===========================================================================
   PLANNED ABSENCE - the parent's endpoints

   Morning only, by design: the afternoon needs no declaration, because a child
   marked absent in the morning is carried forward automatically and a driver
   can board anyone who turns up anyway.

   Two shapes of request, one endpoint:

     "he woke up sick"      -> no dates at all, applied to today
     "I am driving him Tue" -> from/to, stored and consumed at run start
   =========================================================================== */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
//One request may not book more than a month. Bounds how many rows a single
//call can create, and a parent planning further out than that is guessing.
const MAX_DAYS = 30;

function readDate(value, label) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !DATE_ONLY.test(value)) {
        throw httpError(400, `Invalid ${label} date, expected YYYY-MM-DD`);
    }
    return value;
}

//Dates are compared as strings throughout. They are all YYYY-MM-DD, which
//sorts chronologically, and never turning one into a Date is what keeps a
//timezone from moving it a day.
function eachDay(from, to) {
    const days = [];
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);

    while (cursor <= end) {
        days.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
}

//UTC throughout for the same reason: this is calendar arithmetic on a label,
//not a moment in time, so no local timezone may touch it.
function addDays(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/*
    Resolves the window a request is asking for.

    An absent `from` means today, and the server decides what today is. That is
    not a convenience: the sick-on-waking case is the one where "today" is being
    computed rather than chosen, and a phone on the wrong timezone would
    otherwise book the wrong day silently. When a parent picks a date off a
    calendar they are naming a day, not computing one, so that is sent.
*/
async function readWindow(body) {
    const today = await db.schoolToday();

    const from = readDate(body?.from, "from") ?? today;
    const to = readDate(body?.to, "to") ?? from;

    if (to < from) throw httpError(400, "to must not be before from");
    if (from < today) throw httpError(400, "Cannot declare an absence in the past");

    const days = eachDay(from, to);
    if (days.length > MAX_DAYS) {
        throw httpError(400, `A single request may cover at most ${MAX_DAYS} days`);
    }

    return { today, days };
}

function readStudentId(value) {
    const studentid = Number(value);
    if (!Number.isInteger(studentid)) throw httpError(400, "Invalid studentid");
    return studentid;
}

/*
    Declare one or more days.

    Each day is reported on separately rather than the whole request failing on
    one bad day: a parent booking Monday to Friday whose child is already aboard
    this morning should still get Tuesday to Friday. A request where NO day
    could be honoured is a 409, so a single-day call - the common one - still
    fails loudly instead of returning a success full of refusals.

      planned   the row exists, and today's run will read it
      existing  it was already declared; nothing changed
      live      the run is already under way and the child was taken off it now
      too_late  the child is aboard, or that run has already finished
*/
exports.declareAbsence = async (req, res, next) => {
    try {
        const parentid = req.user.userid;
        const studentid = readStudentId(req.body?.studentid);

        if (!(await db.studentBelongsToParent(studentid, parentid))) {
            //404 rather than 403: whether a student exists is not something an
            //unrelated parent should be able to probe for.
            throw httpError(404, "Student not found");
        }

        const { today, days } = await readWindow(req.body);
        const run = await db.morningRunStateFor(studentid);
        const results = [];
        let live = null;

        for (const date of days) {
            /*
                Only today can be anything other than a plain row - every future
                run has yet to build its register, and will read the table when
                it does.
            */
            if (date === today && run) {
                const startedToday = run.started_today === true;
                const inProgress = run.morning_status === ROUTE_STATUS.IN_PROGRESS && startedToday;
                const finished = run.morning_status === ROUTE_STATUS.COMPLETED && startedToday;

                if (finished) {
                    results.push({ date, state: "too_late", reason: "run_finished" });
                    continue;
                }

                if (inProgress) {
                    const aboard = run.attendance_status !== null
                        && run.attendance_status !== ATTENDANCE_STATUS.WAITING
                        && run.attendance_status !== ATTENDANCE_STATUS.ABSENT;

                    if (aboard) {
                        results.push({ date, state: "too_late", reason: "already_boarded" });
                        continue;
                    }

                    //Recorded as well as applied. restartTrip deletes the day's
                    //attendance rows, and the declaration has to survive that.
                    await db.declareDay(studentid, date, parentid);
                    live = await db.parentAbsentToday(studentid, parentid);
                    results.push({ date, state: "live" });
                    continue;
                }
            }

            const row = await db.declareDay(studentid, date, parentid);
            results.push({ date, state: row.created ? "planned" : "existing" });
        }

        if (results.every((r) => r.state === "too_late")) {
            const reason = results[0].reason === "already_boarded"
                ? "That child is already on the bus - ask the driver"
                : "This morning's run has already finished";
            throw httpError(409, reason);
        }

        /*
            The socket and the push go out only for a live change, and only
            after the write. A future booking changes nothing anyone is looking
            at right now.
        */
        if (live && live.changed) {
            getIO().to(`route:${live.routeid}`).emit(SOCKET_EVENT.ATTENDANCE_UPDATED, {
                attendanceid: live.attendanceid,
                phase: "morning",
                old_status: live.old_status,
                new_status: live.new_status
            });

            /*
                The child has left the queue, so the bus is now coming to
                somebody else and their parent should hear about it.

                No push to the parent who asked: they are holding the response
                that says it worked, and telling them their child is absent
                would be repeating their own words back at them.
            */
            notifyNextUp(live.routeid);
        }

        res.json({ studentid: studentid, days: results });
    } catch (err) {
        console.log("Server Error (declareAbsence): " + err);
        next(err);
    }
}

/*
    Cancel one declared day.

    Only a declaration can be cancelled here. Once today's run has started, the
    declaration has already become an ABSENT attendance row, and taking it back
    means putting a child back on a bus that is already out - which is the
    driver's call, not an API's.
*/
exports.cancelAbsence = async (req, res, next) => {
    try {
        const parentid = req.user.userid;
        const studentid = readStudentId(req.body?.studentid);

        const date = readDate(req.body?.date, "date");
        if (!date) throw httpError(400, "date is required");

        const today = await db.schoolToday();
        if (date < today) throw httpError(400, "Cannot cancel an absence in the past");

        if (date === today) {
            const run = await db.morningRunStateFor(studentid);
            const startedToday = run?.started_today === true;
            if (run && startedToday && run.morning_status !== null) {
                throw httpError(409, "This morning's run has already started - ask the driver");
            }
        }

        const removed = await db.cancelDay(studentid, date, parentid);
        if (!removed) throw httpError(404, "No absence declared for that day");

        res.json({ studentid: studentid, date: date, cancelled: true });
    } catch (err) {
        console.log("Server Error (cancelAbsence): " + err);
        next(err);
    }
}

//Everything this parent has declared, for rendering a calendar. Defaults to
//the window a parent can actually still act on: today and the next 30 days.
exports.listAbsences = async (req, res, next) => {
    try {
        const parentid = req.user.userid;
        const today = await db.schoolToday();

        const from = readDate(req.query.from, "from") ?? today;
        const to = readDate(req.query.to, "to") ?? addDays(from, MAX_DAYS);

        if (to < from) throw httpError(400, "to must not be before from");

        const absences = await db.listForParent(parentid, from, to);
        res.json({ from: from, to: to, absences: absences });
    } catch (err) {
        console.log("Server Error (listAbsences): " + err);
        next(err);
    }
}