const pool = require("./pool.js");
const { httpError } = require("../utils/functions.js");
const { ROLE } = require("../utils/enum.js");

const SCHOOL_TZ = process.env.SCHOOL_TZ;

//Returns all the users except yourself (Admin)
async function getAllUsers(id) {
    const { rows } = await pool.query("SELECT * FROM users WHERE id <> $1", [id]);
    return rows;
}

async function getStudentFromParentId(parentid) {
    const { rows } = await pool.query(`
        SELECT s.*, sk.name AS school_name
        FROM students s
        LEFT JOIN school sk ON s.schoolid = sk.id
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

async function searchByPhone(phone) {
    const cleanQuery = `%${phone}%`;
    const { rows } = await pool.query(`
        SELECT id, first_name, last_name, phone, role 
        FROM users 
        WHERE phone ILIKE $1
    `, [cleanQuery]);
    
    return rows;
}

async function searchByString(query) {
    const cleanQuery = `%${query}%`;
    const { rows } = await pool.query(`
        SELECT id, first_name, last_name, phone, role
        FROM users
        WHERE first_name ILIKE $1
        OR last_name ILIKE $1
        OR CONCAT(first_name, ' ', last_name) ILIKE $1
    `, [cleanQuery]);

    return rows;
}

async function getAllStudents() {
    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.parentid, s.routeid, s.schoolid, sk.name AS school_name,
        CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
        u.phone
        FROM students s
        JOIN users u ON s.parentid = u.id
        LEFT JOIN school sk ON s.schoolid = sk.id
    `);

    return rows;
}

async function updateStudent(studentid, first_name, schoolid) {
    await pool.query("UPDATE students SET first_name = $2, schoolid = $3 WHERE id = $1", [studentid, first_name, schoolid]);
}

async function searchStudent(query) {
    const cleanQuery = `%${query}%`;
    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.routeid, s.parentid,
        u.first_name AS parent_first, u.last_name AS parent_last, CONCAT(u.first_name, ' ', u.last_name) AS parent_name, u.phone
        FROM students s
        LEFT JOIN users u ON u.id = s.parentid
        WHERE s.first_name ILIKE $1
         OR u.first_name ILIKE $1
         OR u.last_name ILIKE $1
         OR CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        ORDER BY s.id
    `, [cleanQuery]);

    return rows;
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

module.exports = {
    getAllUsers,
    getStudentFromParentId,
    updateUser,
    deleteStudentById,
    deleteUserById,
    searchByPhone,
    searchByString,
    getAllStudents,
    updateStudent,
    searchStudent,
    searchParentName,
    updateStudentParent,
    getRouteOwnership,
    upsertDriverLocation,
    getDriverLocation,
    getRouteGeometry,
    getStopsForEta,
    canAccessRoute
}