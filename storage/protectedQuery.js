const pool = require("./pool.js");

async function getUserById(id) {
    const { rows } = await pool.query("SELECT id, first_name, last_name, phone, createdat FROM users WHERE id = $1", [id]);
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

module.exports = {
    getUserById,
    getStudentById,
    getRoutesByDriverId
}