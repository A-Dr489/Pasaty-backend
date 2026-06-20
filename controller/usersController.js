const db = require("../storage/usersQuery.js");

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
    const parentid = req.params.id;
    try{
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

exports.deleteStudent = async (req, res) => {
    const studentid = req.params.id;
    try {
        await db.deleteStudentById(studentid);

        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (deleteStudent): " + e);
        res.status(500).json({message: "Internal Server Error"});
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