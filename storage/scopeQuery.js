const pool = require("./pool.js");
const { httpError, assertInScope, schoolScope } = require("../utils/functions.js");
const { ROLE } = require("../utils/enum.js");

/* ===========================================================================
   SCHOOL SCOPE - resolving a record to the school that owns it

   A school account reaches every portal endpoint and then sees only its own
   school's rows. List endpoints do that with a filter; anything addressed by a
   single id has to look the owner up first, and that is what lives here.

   Four lookups because there are four ways into the data - a route, a student,
   an attendance row, a user - and every scoped endpoint arrives through one of
   them.

   EVERY REFUSAL IS 404, INCLUDING "NOT YOURS".

   A 403 on another school's route confirms that route exists, which turns any
   of these endpoints into a way to enumerate the rest of the system one id at a
   time. Out of scope and not present must be indistinguishable from outside,
   so the guards below throw the same error for both.
   =========================================================================== */

//The route's owning school. Null row rather than a thrown error, so the caller
//decides - some endpoints answer 404 and some 400 for a missing route.
async function routeSchool(routeid) {
    const { rows } = await pool.query("SELECT id, schoolid FROM routes WHERE id = $1", [routeid]);
    return rows[0] ?? null;
}

async function studentSchool(studentid) {
    const { rows } = await pool.query("SELECT id, schoolid FROM students WHERE id = $1", [studentid]);
    return rows[0] ?? null;
}

//An attendance row belongs to whichever school owns its route. There is no
//schoolid on attendance and there should not be - it would be a second copy of
//a fact routes already holds, free to disagree with it.
async function attendanceSchool(attendanceid) {
    const { rows } = await pool.query(`
        SELECT a.id, r.schoolid
        FROM attendance a
        JOIN routes r ON r.id = a.routeid
        WHERE a.id = $1
    `, [attendanceid]);
    return rows[0] ?? null;
}

/* ---------------------------------------------------------------------------
   USERS - the derived scope

   Parents and drivers carry no school of their own, so theirs is worked out
   from what they are attached to: a parent is this school's if any of their
   children is at it, a driver if any of their routes is. Derived rather than
   stored means it cannot drift out of step with the truth.

   The third arm is the exception, and a deliberate one. A driver with no route
   at all belongs to nobody, and without this a school account would lose a
   driver the instant it created one - nothing to attach them to yet, so nothing
   to be found by. Showing them to every school account leaks nothing, because
   there is no school to leak.

   A portal account - admin, sub-admin, another school account - matches none of
   the three arms, which is what stops a school account seeing or managing one.
--------------------------------------------------------------------------- */
const USER_IN_SCOPE = `
    SELECT
        EXISTS (SELECT 1 FROM students s WHERE s.parentid = u.id AND s.schoolid = $2)
     OR EXISTS (SELECT 1 FROM routes   r WHERE r.driverid = u.id AND r.schoolid = $2)
     OR (u.role = '${ROLE.DRIVER}'
         AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.driverid = u.id))
        AS in_scope
    FROM users u
    WHERE u.id = $1
`;

async function userInSchoolScope(userid, scope) {
    const { rows } = await pool.query(USER_IN_SCOPE, [userid, scope]);
    return rows[0]?.in_scope === true;
}

/* ---------------------------------------------------------------------------
   The guards themselves. Each one loads the owner and compares in a single
   call, so a controller reads as one line and cannot accidentally do the first
   half without the second.
--------------------------------------------------------------------------- */

async function assertRouteInScope(user, routeid) {
    const route = await routeSchool(routeid);
    if(!route) throw httpError(404, "No route with this id");
    assertInScope(user, route.schoolid, "route");
    return route;
}

async function assertStudentInScope(user, studentid) {
    const student = await studentSchool(studentid);
    if(!student) throw httpError(404, "No student with this id");
    assertInScope(user, student.schoolid, "student");
    return student;
}

async function assertAttendanceInScope(user, attendanceid) {
    const row = await attendanceSchool(attendanceid);
    if(!row) throw httpError(404, "No attendance with this id");
    assertInScope(user, row.schoolid, "attendance");
    return row;
}

/*
    Unlike the three above, this one cannot compare a column - there is no
    school on a user - so the whole question goes to the database as the EXISTS
    chain above.

    Skipped entirely when the caller is unscoped, which keeps the extra query
    off every admin request rather than asking it and ignoring the answer.
*/
async function assertUserInScope(user, userid) {
    const scope = schoolScope(user);
    if(scope === null) return;
    if(!(await userInSchoolScope(userid, scope))) throw httpError(404, "No user with this id");
}

module.exports = {
    routeSchool,
    studentSchool,
    attendanceSchool,
    userInSchoolScope,
    assertRouteInScope,
    assertStudentInScope,
    assertAttendanceInScope,
    assertUserInScope,
    USER_IN_SCOPE
};
