const db = require("../storage/protectedQuery.js");
const { httpError } = require("../utils/functions.js");

exports.getProfile = async (req, res) => {
    try{
        const rows = await db.getUserById(req.user.userid);
        
        if(rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        res.json({user: rows[0]})
    } catch(e) {
        console.log("Server Error (getProfile): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getMyRoutes = async (req, res) => {
    try{
        const rows = await db.getRoutesByDriverId(req.user.userid);

        if(rows.length === 0) {
            return res.status(404).json({ message: 'No routes has founded' });
        }

        res.json({routes: rows})
    } catch(e) {
        console.log("Server Error (getMyRoutes): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getStudents = async (req, res) => {
    try{
        const rows = await db.getStudentById(req.user.userid);

        if(rows.length === 0) {
            return res.status(404).json({ message: 'No student has founded' });
        }

        res.json({students: rows})
    } catch(e) {
        console.log("Server Error (getStudents): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}

exports.getStudentAttendance = async (req, res, next) => {
    try{
        const studentid = Number(req.params.studentid);
        if (!Number.isInteger(studentid)) throw httpError(400, 'Invalid studentid');

        const rows = await db.getAttendanceByStudentId(studentid);
        if(rows.length === 0) {
            throw httpError(404, "No attendance found");
        }

        res.json({attendance: rows[0]});
    } catch(err) {
        console.log("Server Error (getStudentAttendance): " + err);
        next(err);
    }
}