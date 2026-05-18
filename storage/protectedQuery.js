const pool = require("./pool.js");

async function getUserById(id) {
    const { rows } = await pool.query("SELECT id, name, phone, createdat FROM users WHERE id = $1", [id]);
    return rows;
}

module.exports = {
    getUserById
}