const pool = require("./pool.js");
const { httpError, isPhoneNumber } = require("../utils/functions.js");
const { ROLE } = require("../utils/enum.js");
const { whereClause } = require("../utils/pagination.js");

const SCHOOL_TZ = process.env.SCHOOL_TZ;

/* ---------------------------------------------------------------------------
   USERS LIST

   One filter set, built once and used by both the page and its count, so the
   number in the header can never describe a different query from the rows
   underneath it.

   The conditions are assembled with positional parameters rather than
   interpolated text: the search term reaches postgres as a value, never as
   SQL, whatever an admin types into the box.
--------------------------------------------------------------------------- */
function userFilters(excludeId, search, role) {
    //An admin has no business deleting or editing themselves from the roster.
    const values = [excludeId];
    const where = ["u.id <> $1"];

    if(role) {
        values.push(role);
        where.push(`u.role = $${values.length}`);
    }

    if(search) {
        /*
            One box, two searches. A string of digits is meant as a phone
            number and would match nothing against a name, so it is compared
            to the phone column instead - with the separators stripped, since
            what is typed is rarely punctuated the way it was stored.
        */
        if(isPhoneNumber(search)) {
            values.push(`%${search.replace(/[\s\-()]/g, '')}%`);
            where.push(`u.phone ILIKE $${values.length}`);
        } else {
            values.push(`%${search}%`);
            const i = values.length;
            where.push(`(
                u.first_name ILIKE $${i}
                OR u.last_name ILIKE $${i}
                OR CONCAT(u.first_name, ' ', u.last_name) ILIKE $${i}
            )`);
        }
    }

    return { where, values };
}

/*
    One page of users, newest first.

    The columns are listed rather than selected with *: users holds the
    password hash and the token version, and neither has any reason to travel
    to a browser.
*/
async function getUsersPage({ excludeId, search, role, cursor, limit }) {
    const { where, values } = userFilters(excludeId, search, role);

    if(cursor !== null) {
        values.push(cursor);
        where.push(`u.id < $${values.length}`);
    }

    //limit + 1: the extra row is what proves there is another page.
    values.push(limit + 1);

    const { rows } = await pool.query(`
        SELECT u.id, u.first_name, u.last_name, u.phone, u.role, u.createdat
        FROM users u
        ${whereClause(where)}
        ORDER BY u.id DESC
        LIMIT $${values.length}
    `, values);

    return rows;
}

//How many rows the current filters match in total, which is the only number a
//paged list cannot work out for itself.
async function countUsers({ excludeId, search, role }) {
    const { where, values } = userFilters(excludeId, search, role);
    const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS total
        FROM users u
        ${whereClause(where)}
    `, values);

    return rows[0].total;
}

async function getStudentFromParentId(parentid) {
    const { rows } = await pool.query(`
        SELECT s.*, sk.name AS school_name, r.name AS route_name
        FROM students s
        LEFT JOIN school sk ON s.schoolid = sk.id
        LEFT JOIN routes r ON s.routeid = r.id
        WHERE parentid = $1
    `, [parentid]);
    return rows;
}

async function updateUser(userid, Fname, Lname, phone, role, students) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");

        const { rows } = await client.query(
            `
                SELECT r.id AS routeid, r.name AS route_name
                FROM users u
                JOIN routes r ON r.driverid = u.id
                WHERE u.id = $1
                AND u.role = 'driver'
                AND $2 <> 'driver'
                LIMIT 1
            `,
            [userid, role]
        );

        if (rows.length > 0) {
            throw httpError(400, "This driver is already assigned to the route: " + rows[0].route_name);
        }

        await client.query(
          "UPDATE users SET first_name = $1, last_name = $2, phone = $3, role = $4 WHERE id = $5",
          [Fname, Lname, phone, role, userid],
        );
        
        for (const student of students) {
          await client.query(
            `
                INSERT INTO students (
                    first_name,
                    parentid,
                    schoolid
                )
                VALUES ($1, $2, $3)
            `,
            [student.first_name, userid, student.schoolid],
          );
        }

        await client.query("COMMIT");
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

async function deleteStudentById(id) {
    const { rowCount } = await pool.query(`
        DELETE FROM students s 
        WHERE id = $1
        AND NOT EXISTS (
            SELECT 1
            FROM waypoints w
            WHERE w.studentid = s.id
        )`
    , [id]);

    return rowCount > 0;
}

async function deleteUserById(userid) {
    await pool.query("DELETE FROM users WHERE id = $1", [userid]);
}

/* ---------------------------------------------------------------------------
   STUDENTS LIST

   Every join here is a LEFT JOIN, including the one to users. students.parentid
   is nullable, and a student with no parent attached is exactly the row an
   admin needs to find in order to attach one - an inner join would hide it from
   the only screen that can fix it.

   The school and route filters compare ids, not names. Two schools may share a
   name, names get corrected, and the dropdown already knows the id.
--------------------------------------------------------------------------- */
const STUDENT_FROM = `
    FROM students s
    LEFT JOIN users u ON u.id = s.parentid
    LEFT JOIN school sk ON sk.id = s.schoolid
    LEFT JOIN routes r ON r.id = s.routeid
`;

function studentFilters(search, schoolid, routeid) {
    const values = [];
    const where = [];

    if(search) {
        //The box searches the child and the parent together: an admin looking
        //for a family knows one of the two names, not which one we store where.
        values.push(`%${search}%`);
        const i = values.length;
        where.push(`(
            s.first_name ILIKE $${i}
            OR u.first_name ILIKE $${i}
            OR u.last_name ILIKE $${i}
            OR CONCAT(u.first_name, ' ', u.last_name) ILIKE $${i}
        )`);
    }

    if(schoolid === 'none') {
        where.push("s.schoolid IS NULL");
    } else if(schoolid !== null) {
        values.push(schoolid);
        where.push(`s.schoolid = $${values.length}`);
    }

    if(routeid === 'none') {
        where.push("s.routeid IS NULL");
    } else if(routeid !== null) {
        values.push(routeid);
        where.push(`s.routeid = $${values.length}`);
    }

    return { where, values };
}

async function getStudentsPage({ search, schoolid, routeid, cursor, limit }) {
    const { where, values } = studentFilters(search, schoolid, routeid);

    if(cursor !== null) {
        values.push(cursor);
        where.push(`s.id < $${values.length}`);
    }

    values.push(limit + 1);

    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.parentid, s.routeid, s.schoolid,
        sk.name AS school_name,
        r.name AS route_name,
        CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
        u.phone
        ${STUDENT_FROM}
        ${whereClause(where)}
        ORDER BY s.id DESC
        LIMIT $${values.length}
    `, values);

    return rows;
}

async function countStudents({ search, schoolid, routeid }) {
    const { where, values } = studentFilters(search, schoolid, routeid);
    const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS total
        ${STUDENT_FROM}
        ${whereClause(where)}
    `, values);

    return rows[0].total;
}

async function updateStudent(studentid, first_name, schoolid) {
    await pool.query("UPDATE students SET first_name = $2, schoolid = $3 WHERE id = $1", [studentid, first_name, schoolid]);
}

async function searchParentName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) as full_name, phone
        FROM users u
        WHERE CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        AND u.role = 'parent'
        LIMIT 10;
    `, [cleanName]);
    return rows;
}

async function updateStudentParent(parentid, studentid) {
    await pool.query("UPDATE students SET parentid = $1 WHERE id = $2", [parentid, studentid]);
}

//Live bus location

//Who owns this route and is it actually on a run right now.
async function getRouteOwnership(routeid) {
    const { rows } = await pool.query(`
        SELECT id, driverid, morning_status, afternoon_status
        FROM routes
        WHERE id = $1
    `, [routeid]);
    return rows;
}

/*
    One row per route, overwritten on every ping.
    The WHERE on the conflict branch drops out-of-order pings: a phone that
    lost signal flushes its buffered fixes all at once, and the newest one
    must not be replaced by an older one arriving a moment later.
    No row returned = the ping was stale and nothing changed.
*/
async function upsertDriverLocation(driverid, location) {
    const { rows } = await pool.query(`
        INSERT INTO driver_location
            (routeid, driverid, latitude, longitude, accuracy, speed, heading, recorded_at, updated_at, station, phase, snap_offset)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11)
        ON CONFLICT (routeid) DO UPDATE
        SET driverid = EXCLUDED.driverid,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            accuracy = EXCLUDED.accuracy,
            speed = EXCLUDED.speed,
            heading = EXCLUDED.heading,
            recorded_at = EXCLUDED.recorded_at,
            updated_at = now(),
            station = EXCLUDED.station,
            phase = EXCLUDED.phase,
            snap_offset = EXCLUDED.snap_offset
        WHERE EXCLUDED.recorded_at > driver_location.recorded_at
        RETURNING routeid, driverid, latitude, longitude, accuracy, speed, heading, recorded_at, updated_at, station, phase, snap_offset
    `, [
        location.routeid,
        driverid,
        location.latitude,
        location.longitude,
        location.accuracy,
        location.speed,
        location.heading,
        location.recorded_at,
        location.station ?? null,
        location.phase ?? null,
        location.snap_offset ?? null
    ]);
    return rows;
}

async function getDriverLocation(routeid) {
    const { rows } = await pool.query(`
        SELECT routeid, driverid, latitude, longitude, accuracy, speed, heading, recorded_at, updated_at, station, phase, snap_offset
        FROM driver_location
        WHERE routeid = $1
    `, [routeid]);
    return rows;
}

//The line every estimate on this route is measured against, plus the planned
//pace and when the current run started.
async function getRouteGeometry(routeid) {
    const { rows } = await pool.query(`
        SELECT id, geo, distance, duration,
               morning_started_at, afternoon_started_at
        FROM routes
        WHERE id = $1
    `, [routeid]);
    return rows;
}

/*
    Every student stop on the route that could still be waiting, with today's
    attendance beside it. Stops with no station are left out: the geometry has
    not been regenerated since they were added, so there is nowhere to place
    them on the line.
*/
async function getStopsForEta(routeid) {
    const { rows } = await pool.query(`
        SELECT w.studentid, w.station, w.sort_number,
               a.id AS attendanceid,
               a.morning_status, a.afternoon_status
        FROM waypoints w
        LEFT JOIN attendance a
            ON a.studentid = w.studentid
            AND a.routeid = w.routeid
            AND a.attendance_date = (now() AT TIME ZONE $2)::date
        WHERE w.routeid = $1
            AND w.studentid IS NOT NULL
            AND w.station IS NOT NULL
        ORDER BY w.sort_number
    `, [routeid, SCHOOL_TZ]);
    return rows;
}

/*
    Who may watch a route room: an admin sees every route, a driver only the
    routes assigned to them, a parent only a route one of their students rides.
    Any other role gets nothing.
*/
async function canAccessRoute(userid, role, routeid) {
    if(role === ROLE.ADMIN) {
        return true;
    }

    if(role === ROLE.DRIVER) {
        const { rowCount } = await pool.query(
            "SELECT 1 FROM routes WHERE id = $1 AND driverid = $2",
            [routeid, userid]
        );
        return rowCount > 0;
    }

    if(role === ROLE.PARENT) {
        const { rowCount } = await pool.query(
            "SELECT 1 FROM students WHERE routeid = $1 AND parentid = $2 LIMIT 1",
            [routeid, userid]
        );
        return rowCount > 0;
    }

    return false;
}

//Every stored session for one user, newest first.
//
//The token column comes back so the controller can read the version baked into
//it and work out which row is the live session. It is stripped there and never
//reaches the browser.
async function getRefreshTokensByUser(userid) {
    const { rows } = await pool.query(`
        SELECT t.id, t.userid, t.token, t.createdat, t.expireat,
        u.version AS user_version
        FROM refreshtokens t
        JOIN users u ON u.id = t.userid
        WHERE t.userid = $1
        ORDER BY t.createdat DESC
    `, [userid]);
    return rows;
}

/*
    Deletes one stored session and signs the user out everywhere.

    Both halves are needed and they do different jobs. Removing the row stops
    the refresh endpoint minting new access tokens (postRefresh looks the row
    up and 403s when it is gone). Bumping users.version is what invalidates the
    access token the user is already holding, since authenticateUser compares
    that version on every request and never consults this table. Without the
    bump they stay signed in until their 15 minute token expires.

    The version is per user, so this ends all of that user's sessions, not only
    the row that was deleted. The remaining rows stay listed but stop counting
    as current, which is what the admin sees.

    userid is in the WHERE alongside the id: an admin editing one user must not
    be able to delete another user's session by passing a foreign token id.

    Returns false when nothing matched, so the caller can 404 rather than
    reporting a success that revoked nothing — and the version is left alone in
    that case.
*/
async function revokeRefreshToken(tokenid, userid) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const { rowCount } = await client.query(
            "DELETE FROM refreshtokens WHERE id = $1 AND userid = $2",
            [tokenid, userid]
        );

        if(rowCount === 0) {
            await client.query("ROLLBACK");
            return false;
        }

        await client.query("UPDATE users SET version = version + 1 WHERE id = $1", [userid]);

        await client.query("COMMIT");
        return true;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    getUsersPage,
    countUsers,
    getRefreshTokensByUser,
    revokeRefreshToken,
    getStudentFromParentId,
    updateUser,
    deleteStudentById,
    deleteUserById,
    getStudentsPage,
    countStudents,
    updateStudent,
    searchParentName,
    updateStudentParent,
    getRouteOwnership,
    upsertDriverLocation,
    getDriverLocation,
    getRouteGeometry,
    getStopsForEta,
    canAccessRoute
}