const pool = require("./pool.js");

const SCHOOL_TZ = process.env.SCHOOL_TZ;

async function getUserById(id) {
    const { rows } = await pool.query("SELECT id, first_name, last_name, phone, role, createdat FROM users WHERE id = $1", [id]);
    return rows;
}

async function getStudentById(id) {
    const { rows } = await pool.query("SELECT * FROM students WHERE parentid = $1", [id]);
    return rows;
}

async function getRoutesByDriverId(driverid) {
    const { rows } = await pool.query("SELECT id, name FROM routes WHERE driverid = $1", [driverid])
    return rows;
}

async function getAttendanceByStudentId(studentid) {
    const { rows } = await pool.query(`
        SELECT id, morning_status, afternoon_status, attendance_date, studentid
        FROM attendance
        WHERE studentid = $1
        AND attendance_date = (now() AT TIME ZONE $2)::date
    `, [studentid, SCHOOL_TZ]);

    return rows;
}

module.exports = {
    getUserById,
    getStudentById,
    getRoutesByDriverId,
    getAttendanceByStudentId
}