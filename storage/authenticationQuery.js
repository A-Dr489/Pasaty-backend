const pool = require("./pool.js");

async function addUser(Fname, Lname, phone, password) {
    const { rows } = await pool.query("INSERT INTO users (first_name, last_name, phone, password) VALUES ($1, $2, $3, $4) RETURNING id, first_name, last_name, phone", [Fname, Lname, phone, password]);
    return rows;
}

async function getUserByPhone(phone) {
    const { rows } = await pool.query("SELECT * FROM users WHERE phone = $1", [phone]);
    return rows;
}

async function addRefreshToken(userid, token, expire) {
    await pool.query("INSERT INTO refreshtokens (userid, token, expireat) VALUES ($1, $2, $3)", [userid, token, expire])
}

async function checkForRefreshToken(token, userid) {
    const { rows } = await pool.query("SELECT * FROM refreshtokens WHERE token = $1 AND userid = $2", [token, userid]);
    return rows;
}

async function deleteRefreshToken(token) {
    await pool.query("DELETE FROM refreshtokens WHERE token = $1", [token]);
}

async function getUserById(id) {
    const { rows } = await pool.query("SELECT id, first_name, last_name, phone, createdat FROM users WHERE id = $1", [id]);
    return rows;
}

async function updateTokenVersion(id) {
    const { rows } = await pool.query("UPDATE users SET version = version + 1 WHERE id = $1 RETURNING version", [id]);
    return rows;
}

async function checkTokenVersion(id) {
    const { rows } = await pool.query("SELECT version FROM users WHERE id = $1", [id]);
    return rows;
}

module.exports = {
    addUser,
    getUserByPhone,
    addRefreshToken,
    checkForRefreshToken,
    deleteRefreshToken,
    getUserById,
    updateTokenVersion,
    checkTokenVersion
}