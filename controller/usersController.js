const db = require("../storage/usersQuery.js");
const { getIO } = require("../sockets/socketHandler.js");
const { isPhoneNumber } = require("../utils/functions.js");
const { httpError, socketOk, socketError } = require("../utils/functions.js");
const { ROLE, ROUTE_STATUS, SOCKET_EVENT } = require("../utils/enum.js");

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

        const saved = await db.upsertDriverLocation(socket.user.userid, location);
        //Nothing back means the upsert guard dropped an out-of-order ping.
        if(saved.length === 0) return socketOk(ack, {stale: true});

        getIO().to(`route:${location.routeid}`).emit(SOCKET_EVENT.BUS_LOCATION, saved[0]);

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