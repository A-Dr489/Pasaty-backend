const pool = require("./pool.js");
const format = require("pg-format");
const { httpError } = require("../utils/functions.js");

async function addRouteName(name) {
    const { rows } = await pool.query("INSERT INTO routes (name) VALUES ($1) RETURNING id", [name]);
    return rows;
}

async function getAllRoutes() {
    const { rows } = await pool.query("SELECT id, name, updatedat FROM routes ORDER BY id DESC");
    return rows;
}

async function getWaypointsByRoute(routeid) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");

        const waypoints = await client.query(`
            SELECT
                EXISTS (
                    SELECT 1
                    FROM routes
                    WHERE id = $1
                ) AS route_exists,
                COALESCE(
                    json_agg(
                        to_jsonb(w) ||
                        jsonb_build_object(
                            'student_name',
                            CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name)
                        )
                        ORDER BY w.sort_number
                    ) FILTER (WHERE w.id IS NOT NULL),
                    '[]'
                ) AS waypoints
            FROM waypoints w
            LEFT JOIN students s
                ON s.id = w.studentid
            LEFT JOIN users u
                ON u.id = s.parentid
            WHERE w.routeid = $1;
        `, [routeid]);

        let driver = await client.query("SELECT driverid FROM routes WHERE id = $1", [routeid]);
        if(driver.rows[0].driverid) {
            const fullDriver = await client.query("SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) as full_name FROM users u WHERE id = $1", [driver.rows[0].driverid]);
            driver = fullDriver;
        }

        await client.query("COMMIT");
        return {waypoints: waypoints.rows, driver: driver.rows};
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

async function saveDraftChanges(routeid, inserts, updates, deletes) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const studentRouteMap = new Map();

        if(deletes.length > 0) {
            const { rows: deletedRows } = await client.query("DELETE FROM waypoints WHERE id = ANY($1::int[]) RETURNING studentid", [deletes]);
            for (const row of deletedRows) {
                if (row.studentid !== null) {
                    studentRouteMap.set(row.studentid, null);
                }
            }
        }

        for (const item of [...inserts, ...updates]) {
            const studentid = item.studentid === "" || item.type !== "student" ? null : item.studentid;
            if (studentid !== null) {
                studentRouteMap.set(Number(studentid), Number(routeid));
            }
        }

        if(inserts.length > 0) {
            const insertValues = inserts.map((insert) => [
              routeid,
              insert.name ? insert.name : insert.type + "_" + insert.sort_number,
              insert.longitude,
              insert.latitude,
              insert.sort_number,
              insert.type,
              insert.studentid === "" || insert.type !== "student"? null : insert.studentid,
            ]);
            const queryInsert = format(`INSERT INTO waypoints (routeid, name, longitude, latitude, sort_number, type, studentid) VALUES %L`, insertValues);
            await client.query(queryInsert);
        }

        if(updates.length > 0) {
            const updateValues = updates.map((update) => [
                update.id,
                update.name ? update.name : update.type + "_" + update.sort_number, 
                update.longitude, 
                update.latitude, 
                update.sort_number, 
                update.type, 
                update.studentid === "" || update.type !== "student" ? null : update.studentid
            ]);
            
            const queryUpdate = format(`
                UPDATE waypoints AS w
                SET 
                    name = data.name,
                    longitude = data.longitude::numeric,
                    latitude = data.latitude::numeric,
                    sort_number = data.sort_number::int,
                    type = data.type,
                    studentid = data.studentid::int
                FROM (VALUES %L) AS data(id, name, longitude, latitude, sort_number, type, studentid)
                WHERE w.id = data.id::int;
            `, updateValues);

            await client.query(queryUpdate);
        }

        if (studentRouteMap.size > 0) {
            const studentRouteValues = Array.from(studentRouteMap.entries()); // [studentid, routeid | null]
            const queryStudents = format(`
                UPDATE students AS s
                SET routeid = data.routeid::int
                FROM (VALUES %L) AS data(studentid, routeid)
                WHERE s.id = data.studentid::int;
            `, studentRouteValues);
            await client.query(queryStudents);
        }

        await client.query("UPDATE routes SET distance = NULL, duration = NULL, geo = NULL WHERE id = $1", [routeid]);

        const { rows } = await client.query("SELECT * FROM waypoints WHERE routeid = $1", [routeid]);
        
        await client.query("COMMIT");
        return rows;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

async function updateRoutes(routeid, route) {
    const { rows } = await pool.query(`
                UPDATE routes SET 
                geo = $1,
                duration = $2,
                distance = $3,
                updatedat = CURRENT_TIMESTAMP
                WHERE id = $4
                RETURNING geo, duration, distance
        `, [route.geometry, route.duration, route.distance, routeid]);
    return rows;
}

async function getRouteWithDistance(routeid) {
    const { rows } = await pool.query(`
        SELECT r.*, 
        (r.distance IS NOT NULL AND r.distance != 'NaN') AS has_distance 
        FROM routes r 
        WHERE r.id = $1
    `, [routeid]);
    return rows;
}

async function searchRouteName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query("SELECT id, name, updatedat FROM routes WHERE name ILIKE $1 ORDER BY id DESC", [cleanName]);
    return rows;
}

async function searchStudentName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT s.id, CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name) as full_name
        FROM students s
        JOIN users u
        ON u.id = s.parentid
        WHERE CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name) ILIKE $1
        ORDER BY full_name
        LIMIT 20;
    `, [cleanName]);
    return rows;
}

async function deleteRouteById(routeid) {
    await pool.query("DELETE FROM routes WHERE id = $1", [routeid]);
}

async function searchDriverName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) as full_name
        FROM users u
        WHERE CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        AND u.role = 'driver'
        LIMIT 10;
    `, [cleanName]);
    return rows;
}

async function updateDriver(userid, routeid) {
    await pool.query("UPDATE routes SET driverid = $1 WHERE id = $2", [userid, routeid]);
}

async function getDriverRoute(routeid, driverid) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");
        const { rows: routeData } = await client.query(`
            SELECT id, name, geo, distance, duration, updatedat, driverid
            FROM routes r
            WHERE id = $1
            AND driverid = $2
        `, [routeid, driverid]);

        if(driverid != routeData[0].driverid) {
            throw httpError(403, 'Driver not assigned to this route');
        }
        if(routeData.length === 0) throw httpError(404, "No route found");

        const { rows: waypoints } = await client.query(`
            SELECT *
            FROM waypoints
            WHERE routeid = $1    
        `, [routeid]);

        if(waypoints.length === 0) throw httpError(404, "No waypoint found");

        await client.query("COMMIT");
        return {routeData: routeData, waypoints: waypoints};
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    addRouteName,
    getAllRoutes,
    getWaypointsByRoute,
    saveDraftChanges,
    updateRoutes,
    getRouteWithDistance,
    searchRouteName,
    searchStudentName,
    deleteRouteById,
    searchDriverName,
    updateDriver,
    getDriverRoute
}