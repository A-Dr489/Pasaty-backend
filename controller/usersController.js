const db = require("../storage/usersQuery.js");
const { isPhoneNumber } = require("../utils/functions.js");
const { httpError } = require("../utils/functions.js");

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

exports.updateUser = async (req, res) => {
    const {first_name, last_name, phone, role, students} = req.body;
    const userid = req.params.id;
    try {
        await db.updateUser(userid, first_name, last_name, phone, role, students);
        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (updateUser): " + e);
        res.status(500).json({message: "Internal Server Error"});
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