const pool = require("./pool.js");
const format = require("pg-format");
const { httpError } = require("../utils/functions.js");
const { whereClause } = require("../utils/pagination.js");

async function addRouteName(name, schoolid) {
    const { rows } = await pool.query("INSERT INTO routes (name, schoolid) VALUES ($1, $2) RETURNING id", [name, schoolid]);
    return rows;
}

/* ---------------------------------------------------------------------------
   ROUTES LIST

   Same shape as the users and students lists: one filter set feeding both the
   page and its count, keyset paged on id DESC.
--------------------------------------------------------------------------- */
const ROUTE_FROM = `
    FROM routes r
    LEFT JOIN school sk ON sk.id = r.schoolid
`;

function routeFilters(search, schoolid) {
    const values = [];
    const where = [];

    if(search) {
        values.push(`%${search}%`);
        where.push(`r.name ILIKE $${values.length}`);
    }

    if(schoolid === 'none') {
        where.push("r.schoolid IS NULL");
    } else if(schoolid !== null) {
        values.push(schoolid);
        where.push(`r.schoolid = $${values.length}`);
    }

    return { where, values };
}

async function getRoutesPage({ search, schoolid, cursor, limit }) {
    const { where, values } = routeFilters(search, schoolid);

    if(cursor !== null) {
        values.push(cursor);
        where.push(`r.id < $${values.length}`);
    }

    values.push(limit + 1);

    const { rows } = await pool.query(`
        SELECT r.id, r.name, r.updatedat, r.schoolid,
        sk.name AS school_name
        ${ROUTE_FROM}
        ${whereClause(where)}
        ORDER BY r.id DESC
        LIMIT $${values.length}
    `, values);

    return rows;
}

async function countRoutes({ search, schoolid }) {
    const { where, values } = routeFilters(search, schoolid);
    const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS total
        ${ROUTE_FROM}
        ${whereClause(where)}
    `, values);

    return rows[0].total;
}

/*
    Every route, id and name only, for the route dropdown on the students page.

    This one is deliberately not paged. A filter's options have to describe the
    whole table or the filter lies - offering only the routes that happen to be
    on the page you have scrolled to would hide the very rows you are trying to
    find. It stays cheap because it is two columns and no joins, and a fleet has
    routes in the hundreds, not the millions.

    schoolid rides along so the page can narrow the list to the school already
    chosen without asking again.Driver
*/
async function getRouteOptions(scope = null) {
    const { rows } = await pool.query(`
        SELECT id, name, schoolid
        FROM routes
        WHERE $1::int IS NULL OR schoolid = $1
        ORDER BY name
    `, [scope]);
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

        /*
            A child may only ride a route belonging to their own school.

            students.schoolid and routes.schoolid were independent, so nothing
            stopped one school's student being dropped onto another's route -
            and once there they appear in that route's register, its attendance
            exports and its live board. That is a hole in the school scope with
            nothing to do with roles: filtering reads by routes.schoolid cannot
            help when the foreign child is genuinely on the route.

            Checked inside the transaction against the rows about to be written,
            so a mixed save is refused whole rather than half-applied.
        */
        const attaching = [...studentRouteMap.entries()]
            .filter(([, boundTo]) => boundTo !== null)
            .map(([studentid]) => studentid);

        if(attaching.length > 0) {
            const { rows: foreign } = await client.query(`
                SELECT s.id, s.first_name
                FROM students s
                WHERE s.id = ANY($1::int[])
                  AND s.schoolid IS DISTINCT FROM (SELECT schoolid FROM routes WHERE id = $2)
            `, [attaching, routeid]);

            if(foreign.length > 0) {
                throw httpError(400,
                    `${foreign[0].first_name} belongs to a different school than this route`);
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

        /*
            Both runs go together. The afternoon line visits the same stops in
            the opposite order, so a moved or added stop makes it just as wrong
            as the morning one - leaving it behind would have the afternoon
            driving to where a stop used to be.
        */
        await client.query(`
            UPDATE routes SET
                distance = NULL, duration = NULL, geo = NULL,
                afternoon_distance = NULL, afternoon_duration = NULL, afternoon_geo = NULL
            WHERE id = $1
        `, [routeid]);
        //The stations were measured against those geometries, so they die with them.
        await client.query(`
            UPDATE waypoints SET
                station = NULL, leg_distance = NULL, leg_duration = NULL,
                afternoon_station = NULL, afternoon_leg_distance = NULL, afternoon_leg_duration = NULL
            WHERE routeid = $1
        `, [routeid]);

        /*
            Read back in the same shape getWaypointsByRoute sends, because the
            client replaces its whole waypoint list with this answer.

            student_name is not a column - it is composed from the two joins
            below - so a plain SELECT * returned rows that still carried
            studentid but had lost the name, and every student stop redrew as
            "No student attached" even though the link in the database was
            untouched.

            CONCAT rather than concatenation with ||, matching the read above:
            it treats a null as an empty string, so a stop with no student comes
            back as whitespace the client already trims away rather than as a
            null that would have to be special-cased.
        */
        const { rows } = await client.query(`
            SELECT w.*,
                   CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name) AS student_name
            FROM waypoints w
            LEFT JOIN students s
                ON s.id = w.studentid
            LEFT JOIN users u
                ON u.id = s.parentid
            WHERE w.routeid = $1
            ORDER BY w.sort_number
        `, [routeid]);

        await client.query("COMMIT");
        return rows;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

//The stops in the order the bus drives them, which is the order their
//coordinates are sent to Mapbox.
async function getWaypointsInOrder(routeid) {
    const { rows } = await pool.query(`
        SELECT id, longitude, latitude, sort_number
        FROM waypoints
        WHERE routeid = $1
        ORDER BY sort_number
    `, [routeid]);
    return rows;
}

/*
    Stores both runs of a route: the morning, start -> school, in geo/distance/
    duration, and the afternoon, school -> start, in the afternoon_ columns.

    Each run is { route: {geometry, duration, distance}, stops: [{id, station,
    leg_distance, leg_duration}] }, with every station measured along that run's
    own line from that run's own start.

    geo keeps its unprefixed name because the driver app already reads it. The
    afternoon is added beside it rather than the pair being renamed, so a build
    of the app that has never heard of afternoon_geo carries on working.
*/
async function updateRoutes(routeid, morning, afternoon) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");

        const { rows } = await client.query(`
                UPDATE routes SET
                geo = $1,
                duration = $2,
                distance = $3,
                afternoon_geo = $4,
                afternoon_duration = $5,
                afternoon_distance = $6,
                updatedat = CURRENT_TIMESTAMP
                WHERE id = $7
                RETURNING geo, duration, distance,
                          afternoon_geo, afternoon_duration, afternoon_distance
        `, [
            morning.route.geometry, morning.route.duration, morning.route.distance,
            afternoon.route.geometry, afternoon.route.duration, afternoon.route.distance,
            routeid
        ]);

        /*
            The stations go in the same transaction as the geometry they were
            measured against. Committing one without the other would leave the
            route pointing at a ruler that no longer matches its line.

            One row per stop carrying both runs' numbers, matched up by id: the
            two lists hold the same stops in opposite orders, so their positions
            say nothing about which stop is which.
        */
        const afternoonById = new Map(afternoon.stops.map((stop) => [stop.id, stop]));

        if(morning.stops.length > 0) {
            const stationValues = morning.stops.map((stop) => {
                const back = afternoonById.get(stop.id);
                return [
                    stop.id,
                    stop.station,
                    stop.leg_distance,
                    stop.leg_duration,
                    back ? back.station : null,
                    back ? back.leg_distance : null,
                    back ? back.leg_duration : null
                ];
            });

            const queryStations = format(`
                UPDATE waypoints AS w
                SET
                    station = data.station::double precision,
                    leg_distance = data.leg_distance::double precision,
                    leg_duration = data.leg_duration::double precision,
                    afternoon_station = data.afternoon_station::double precision,
                    afternoon_leg_distance = data.afternoon_leg_distance::double precision,
                    afternoon_leg_duration = data.afternoon_leg_duration::double precision
                FROM (VALUES %L) AS data(id, station, leg_distance, leg_duration,
                                         afternoon_station, afternoon_leg_distance, afternoon_leg_duration)
                WHERE w.id = data.id::int;
            `, stationValues);

            await client.query(queryStations);
        }

        await client.query("COMMIT");
        return rows;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

/*
    has_distance is true only when BOTH runs are generated. A route generated
    before the afternoon had a line of its own has a morning and no afternoon,
    and answering "done" for it would leave it mirroring the morning forever -
    so it is treated as ungenerated, and the next Get Route builds both.
*/
async function getRouteWithDistance(routeid) {
    const { rows } = await pool.query(`
        SELECT r.*,
        (r.distance IS NOT NULL AND r.distance != 'NaN'
         AND r.afternoon_distance IS NOT NULL AND r.afternoon_distance != 'NaN') AS has_distance
        FROM routes r
        WHERE r.id = $1
    `, [routeid]);
    return rows;
}

async function searchStudentName(name, scope = null) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT s.id, CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name) as full_name
        FROM students s
        JOIN users u
        ON u.id = s.parentid
        WHERE CONCAT(s.first_name, ' ', u.first_name, ' ', u.last_name) ILIKE $1
        AND ($2::int IS NULL OR s.schoolid = $2)
        ORDER BY full_name
        LIMIT 20;
    `, [cleanName, scope]);
    return rows;
}

async function deleteRouteById(routeid) {
    await pool.query("DELETE FROM routes WHERE id = $1", [routeid]);
}

/*
    Drivers a caller may attach to one of its routes.

    The scoped arm is the same rule scopeQuery's USER_IN_SCOPE applies: drivers
    already on one of this school's routes, plus drivers on no route at all -
    who belong to nobody, and who a school account has to be able to find or it
    could never assign a driver it just created.
*/
async function searchDriverName(name, scope = null) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) as full_name
        FROM users u
        WHERE CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        AND u.role = 'driver'
        AND ($2::int IS NULL
             OR EXISTS (SELECT 1 FROM routes r WHERE r.driverid = u.id AND r.schoolid = $2)
             OR NOT EXISTS (SELECT 1 FROM routes r WHERE r.driverid = u.id))
        LIMIT 10;
    `, [cleanName, scope]);
    return rows;
}

async function updateDriver(userid, routeid) {
    await pool.query("UPDATE routes SET driverid = $1 WHERE id = $2", [userid, routeid]);
}

async function getDriverRoute(routeid, driverid) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");
        /*
            afternoon_geo is null until the route has been generated since the
            afternoon got a line of its own. The app is expected to fall back to
            reading geo backwards in that case, which is what it did before.
        */
        const { rows: routeData } = await client.query(`
            SELECT id, name, geo, distance, duration,
                   afternoon_geo, afternoon_distance, afternoon_duration,
                   updatedat, driverid
            FROM routes r
            WHERE id = $1
            AND driverid = $2
        `, [routeid, driverid]);

        if(routeData.length === 0) throw httpError(404, "No route found");
        if(driverid != routeData[0].driverid) {
            throw httpError(403, 'Driver not assigned to this route');
        }

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

//The geometry is here for the live view, which draws the line the bus is being
//measured against - the afternoon one during an afternoon run. EditRoute
//ignores it.
async function getRouteById(routeid) {
    const { rows } = await pool.query(`
        SELECT r.id, r.name, r.schoolid, r.geo, r.distance, r.duration,
        r.afternoon_geo, r.afternoon_distance, r.afternoon_duration,
        r.morning_status, r.afternoon_status,
        s.name AS school_name
        FROM routes r
        LEFT JOIN school s ON r.schoolid = s.id
        WHERE r.id = $1
    `, [routeid]);
    return rows;
}

async function updateRouteData(name, schoolid, routeid) {
    await pool.query("UPDATE routes SET name = $1, schoolid = $2 WHERE id = $3", [name, schoolid, routeid])
} 

module.exports = {
    addRouteName,
    getRoutesPage,
    countRoutes,
    getRouteOptions,
    getWaypointsByRoute,
    saveDraftChanges,
    getWaypointsInOrder,
    updateRoutes,
    getRouteWithDistance,
    searchStudentName,
    deleteRouteById,
    searchDriverName,
    updateDriver,
    getDriverRoute,
    getRouteById,
    updateRouteData
}