const jwt = require("jsonwebtoken");
const db = require("../storage/usersQuery.js");
const { getIO } = require("../sockets/socketHandler.js");
const { isPhoneNumber } = require("../utils/functions.js");
const { httpError, socketOk, socketError } = require("../utils/functions.js");
const { ROLE, ROUTE_STATUS, SOCKET_EVENT, PHASE } = require("../utils/enum.js");
const { snapToLine } = require("../utils/geo.js");
const { buildEstimate } = require("../utils/eta.js");

/*
    The stored sessions for one user.

    The refresh token itself is deliberately not in the response. It is a live
    15 day credential, and it is kept in an httpOnly cookie precisely so that
    no browser script can read it — putting it in an admin page would hand a
    working key to anything with sight of that screen, tab or network log.

    What is sent instead is enough to tell the rows apart and decide which to
    end: when it was issued, when it lapses, whether it has already lapsed, and
    whether it is the session in use. That last one comes from the version
    inside the token: every login increments users.version and stamps it into
    the token it issues, so the row whose version still matches the user's is
    the live one and the rest are leftovers from earlier logins.

    decode rather than verify, because an expired row should still be listed
    and verifying would throw on exactly those.
*/
exports.getUserTokens = async (req, res, next) => {
    try{
        const userid = Number(req.params.id);
        if(!Number.isInteger(userid)) throw httpError(400, "Invalid userid");

        const rows = await db.getRefreshTokensByUser(userid);
        const now = Date.now();

        const tokens = rows.map((row) => {
            const payload = jwt.decode(row.token) || {};
            return {
                id: row.id,
                userid: row.userid,
                createdat: row.createdat,
                expireat: row.expireat,
                expired: new Date(row.expireat).getTime() < now,
                current: payload.version === row.user_version,
                role: payload.role ?? null
            };
        });

        res.json({tokens: tokens});
    } catch(err) {
        console.log("Server Error (getUserTokens): " + err);
        next(err);
    }
}

//Ends a stored session. See revokeRefreshToken for why this also bumps the
//user's token version, and what that means for their other sessions.
exports.revokeUserToken = async (req, res, next) => {
    try{
        const userid = Number(req.params.id);
        const tokenid = Number(req.params.tokenid);
        if(!Number.isInteger(userid)) throw httpError(400, "Invalid userid");
        if(!Number.isInteger(tokenid)) throw httpError(400, "Invalid token id");

        const revoked = await db.revokeRefreshToken(tokenid, userid);
        if(!revoked) throw httpError(404, "No session found for this user");

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (revokeUserToken): " + err);
        next(err);
    }
}

exports.getAllUsers = async (req, res) => {
    try{
        const rows = await db.getAllUsers(req.user.userid);
        if(rows.length === 0) {
            return res.status(404).json({message: "No users found"});
        }

        res.json({users: rows});
    } catch(e) {
        console.log("Server Error (getAllUsers): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getStudentFromParent = async (req, res) => {
    try{
        const parentid = req.params.id;
        const rows = await db.getStudentFromParentId(parentid);
        if(rows.length === 0) {
            return res.status(404).json({message: "No students assigned"});
        }

        res.json({students: rows});
    } catch(e) {
        console.log("Server Error (getStudentFromParent): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.updateUser = async (req, res, next) => {
    const {first_name, last_name, phone, role, students} = req.body;
    const userid = req.params.id;
    try {
        await db.updateUser(userid, first_name, last_name, phone, role, students);
        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateUser): " + err);
        next(err)
    }
}

exports.deleteStudent = async (req, res, next) => {
    try {
        const studentid = req.params.id;
        const isDeleted = await db.deleteStudentById(studentid);
        if(!isDeleted) throw httpError(400, "Delete the student's waypoint first");

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (deleteStudent): " + err);
        next(err);
    }
}

exports.deleteUser = async (req, res) => {
    const userid = req.params.id;
    try{
        await db.deleteUserById(userid);

        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (deleteUser): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.searchUser = async (req, res) => {
    try{
        const { search } = req.body;
        if (!search || search.trim() === '') {
            return res.status(400).json({ message: "The search was empty!" });
        }
        const query = search.trim();
        if(isPhoneNumber(query)) {
            const cleanPhone = query.replace(/[\s\-()]/g, '');
            const rows = await db.searchByPhone(cleanPhone);
            if(rows.length === 0) {
                return res.status(404).json({message: "Nothing found phone"});
            }

            res.json({users: rows});
        } else {
            const rows = await db.searchByString(query);
            if(rows.length === 0) {
                return res.status(404).json({message: "Nothing found"});
            }

            res.json({users: rows});
        }

    } catch(e) {
        console.log("Server Error (searchUser): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getStudents = async (req, res, next) => {
    try{
        const rows = await db.getAllStudents();
        if(rows.length === 0) throw httpError(404, "No students found");

        res.json({students: rows});
    } catch(err) {
        console.log("Server Error (getStudents): " + err);
        next(err);
    }
}

exports.updateStudent = async (req, res, next) => {
    try{
        const { first_name, schoolid } = req.body;
        const cleanName = first_name.trim();
        const studentid = req.params.studentid;
        if(!studentid || !cleanName || !schoolid) throw httpError(400, "Insufficient Data") 
        await db.updateStudent(studentid, cleanName, schoolid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateStudent): " + err);
        next(err);
    }
}

exports.searchStudent = async (req, res, next) => {
    try{
        const { search } = req.body;
        if (!search || search.trim() === '') throw httpError(400, "The search was empty!");
        const query = search.trim();
        const rows = await db.searchStudent(query);
        if(rows.length === 0) throw httpError(404, "Nothing found");

        res.json({students: rows});
    } catch(err) {
        console.log("Server Error (searchStudent): " + err);
        next(err);
    }
}

exports.searchParent = async (req, res, next) => {
    try{
        const searchedName = req.params.name;
        const rows = await db.searchParentName(searchedName);
        if(rows.length === 0) throw httpError(404, "No parent found")

        res.json({parents: rows});
    } catch(err) {
        console.log("Server Error (searchParent): " + err);
        next(err);
    }
}

exports.updateStudentParent = async (req, res, next) => {
    try{
        const { parentid } = req.body;
        const studentid = req.params.studentid;
        if(!parentid) throw httpError(400, "No parent provided");
        await db.updateStudentParent(parentid, studentid);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (updateStudentParent): " + err);
        next(err);
    }
}

/* ---------------------------------------------------------------------------
   LIVE BUS LOCATION

   The driver app emits DRIVER_LOCATION to the server; the server validates it,
   stores it, then re-broadcasts it as BUS_LOCATION into the route room. A
   client can never write into a room directly - that round trip through the
   server is what lets us prove the sender really is this route's driver.

   These two take (socket, payload) rather than (req, res, next): they are
   socket handlers wired up in sockets/socketHandler.js, not express routes.
--------------------------------------------------------------------------- */

//A fix looser than this is GPS noise (a cold start indoors), not a position.
const MAX_ACCURACY_METERS = 200;
/*
    Tolerated device clock drift. Without the clamp, one phone running fast
    stamps recorded_at into the future and every later ping from that device
    looks older than what is already stored, so nothing updates again.
*/
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function cleanNumber(value, min, max) {
    const number = Number(value);
    if(!Number.isFinite(number) || number < min || number > max) return null;
    return number;
}

function cleanLocation(payload) {
    const routeid = Number(payload?.routeid);
    const latitude = cleanNumber(payload?.latitude, -90, 90);
    const longitude = cleanNumber(payload?.longitude, -180, 180);

    if(!Number.isInteger(routeid) || latitude === null || longitude === null) {
        return null;
    }

    const accuracy = cleanNumber(payload?.accuracy, 0, Number.MAX_VALUE);
    if(accuracy !== null && accuracy > MAX_ACCURACY_METERS) {
        return null;
    }

    const now = Date.now();
    const reported = payload?.recorded_at ? new Date(payload.recorded_at).getTime() : now;
    const recorded_at = Number.isFinite(reported)
        ? new Date(Math.min(reported, now + MAX_CLOCK_SKEW_MS))
        : new Date(now);

    return {
        routeid,
        latitude,
        longitude,
        accuracy,
        //Geolocator reports -1 for speed/heading when it cannot determine them,
        //so those fall outside the range and land as null instead of -1.
        speed: cleanNumber(payload?.speed, 0, 500),
        heading: cleanNumber(payload?.heading, 0, 360),
        recorded_at
    };
}

//A fix can land a few metres behind the last one without the bus reversing.
const GPS_JITTER_M = 40;
//Fast enough that no bus outruns the search window, slow enough that the
//window still means something after a long silence.
const MAX_PLAUSIBLE_SPEED_MS = 30;
const MIN_FORWARD_WINDOW_M = 200;

/*
    Places the bus on the route line and works out who it is still coming for.

    The afternoon runs the morning line backwards, so for that phase the line
    itself is reversed before anything is measured. Every station downstream
    then means the same thing in both phases - distance covered since this run
    began - and nothing has to branch on direction. When a real afternoon
    geometry replaces the mirrored one, only the line chosen here changes.
*/
async function estimateRoute(route, phase, location, previous, now) {
    const coordinates = route.geo?.coordinates ?? [];
    if(coordinates.length < 2) return null;

    const line = phase === PHASE.AFTERNOON ? [...coordinates].reverse() : coordinates;

    /*
        Only carry progress forward within the same phase. Starting the
        afternoon leaves the bus at the far end of the morning's line, and
        treating that as its position would strand it there for the whole run.
    */
    const carried = previous && previous.phase === phase && previous.station !== null
        ? Number(previous.station)
        : null;

    const secondsSincePrevious = previous
        ? (location.recorded_at.getTime() - new Date(previous.recorded_at).getTime()) / 1000
        : null;

    const window = carried === null ? {} : {
        fromStation: carried,
        backward: GPS_JITTER_M,
        /*
            Widens with the gap since the last fix. A phone that lost signal
            for five minutes comes back far down the road, and a fixed window
            would refuse to believe it had moved.
        */
        forward: Math.max(
            MIN_FORWARD_WINDOW_M,
            (secondsSincePrevious ?? 0) * MAX_PLAUSIBLE_SPEED_MS + MIN_FORWARD_WINDOW_M
        )
    };

    const hit = snapToLine(line, [location.longitude, location.latitude], window);
    if(!hit) return null;

    const stops = await db.getStopsForEta(route.id);
    const startedAt = phase === PHASE.AFTERNOON ? route.afternoon_started_at : route.morning_started_at;

    const estimate = buildEstimate({
        routeid: route.id,
        phase: phase,
        busStation: hit.station,
        //Stations are stored along the morning line, so the afternoon reads
        //them from the other end.
        stops: stops.map((stop) => ({
            ...stop,
            station: phase === PHASE.AFTERNOON ? hit.total - Number(stop.station) : Number(stop.station)
        })),
        plannedPace: route.duration > 0 ? route.distance / route.duration : null,
        elapsedSeconds: startedAt ? (now - new Date(startedAt).getTime()) / 1000 : null,
        snapOffset: hit.offset,
        now: now
    });

    return { station: hit.station, offset: hit.offset, estimate: estimate };
}

exports.handleDriverLocation = async (socket, payload, ack) => {
    try {
        if(socket.user?.role !== ROLE.DRIVER) throw httpError(403, "Only a driver can report a location");

        const location = cleanLocation(payload);
        if(!location) throw httpError(400, "Invalid location payload");

        const rows = await db.getRouteOwnership(location.routeid);
        if(rows.length === 0) throw httpError(404, "Route not found");

        const route = rows[0];
        if(route.driverid !== socket.user.userid) throw httpError(403, "Driver not assigned to this route");

        /*
            Only track a bus that is actually on a run. This is the privacy
            line: outside an active route the driver is off the clock, and we
            have no business storing where they are.
        */
        const running = route.morning_status === ROUTE_STATUS.IN_PROGRESS
            || route.afternoon_status === ROUTE_STATUS.IN_PROGRESS;
        if(!running) throw httpError(409, "Route is not in progress");

        const phase = route.morning_status === ROUTE_STATUS.IN_PROGRESS
            ? PHASE.MORNING
            : PHASE.AFTERNOON;

        /*
            Read before writing: the upsert overwrites the station this ping
            has to be measured against, and that previous station is what keeps
            a route which retraces itself from jumping to the wrong pass.
        */
        const previousRows = await db.getDriverLocation(location.routeid);
        const geometryRows = await db.getRouteGeometry(location.routeid);

        const now = Date.now();
        const placed = geometryRows.length === 0
            ? null
            : await estimateRoute(geometryRows[0], phase, location, previousRows[0], now);

        const saved = await db.upsertDriverLocation(socket.user.userid, {
            ...location,
            phase: phase,
            station: placed ? placed.station : null,
            snap_offset: placed ? placed.offset : null
        });
        //Nothing back means the upsert guard dropped an out-of-order ping.
        if(saved.length === 0) return socketOk(ack, {stale: true});

        getIO().to(`route:${location.routeid}`).emit(SOCKET_EVENT.BUS_LOCATION, saved[0]);

        //A route with no generated geometry still reports its position, it
        //just cannot say when it will arrive anywhere.
        if(placed) {
            getIO().to(`route:${location.routeid}`).emit(SOCKET_EVENT.ETA_UPDATED, placed.estimate);
        }

        socketOk(ack);
    } catch(err) {
        console.log("Socket Error (handleDriverLocation): " + err);
        socketError(socket, ack, err);
    }
}

exports.handleRouteJoin = async (socket, routeid, ack) => {
    try {
        const room = Number(routeid);
        if(!Number.isInteger(room)) throw httpError(400, "Invalid routeid");

        const allowed = await db.canAccessRoute(socket.user.userid, socket.user.role, room);
        if(!allowed) throw httpError(403, "Not allowed to watch this route");

        socket.join(`route:${room}`);
        socketOk(ack, {routeid: room});
    } catch(err) {
        console.log("Socket Error (handleRouteJoin): " + err);
        socketError(socket, ack, err);
    }
}

//Lets a map that opens mid-run show the bus at once instead of waiting
//for the next ping.
exports.getBusLocation = async (req, res, next) => {
    try {
        const routeid = Number(req.params.routeid);
        if(!Number.isInteger(routeid)) throw httpError(400, "Invalid routeid");

        const rows = await db.getDriverLocation(routeid);
        //No row is a normal state: the bus has not reported on this route yet.
        res.json({location: rows[0] ?? null});
    } catch(err) {
        console.log("Server Error (getBusLocation): " + err);
        next(err);
    }
}