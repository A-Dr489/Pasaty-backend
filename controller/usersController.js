const db = require("../storage/usersQuery.js");
const { isPhoneNumber } = require("../utils/functions.js");

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