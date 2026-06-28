const pool = require("./pool.js");
const format = require("pg-format");

async function addRouteName(name) {
    const { rows } = await pool.query("INSERT INTO routes (name) VALUES ($1) RETURNING id", [name]);
    return rows;
}

async function getAllRoutes() {
    const { rows } = await pool.query("SELECT id, name, updatedat FROM routes ORDER BY id DESC");
    return rows;
}
//This might need to be changed to display the student's full name
async function getWaypointsByRoute(routeid) {
    const { rows } = await pool.query(`
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
    return rows;
}

async function saveDraftChanges(routeid, inserts, updates, deletes) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

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

        if(deletes.length > 0) {
            await client.query("DELETE FROM waypoints WHERE id = ANY($1::int[])", [deletes]);
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

module.exports = {
    addRouteName,
    getAllRoutes,
    getWaypointsByRoute,
    saveDraftChanges,
    updateRoutes,
    getRouteWithDistance,
    searchRouteName,
    searchStudentName,
    deleteRouteById
}