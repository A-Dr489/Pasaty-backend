const pool = require("./pool.js");

async function addUser(Fname, Lname, phone, role, password) {
    const { rows } = await pool.query("INSERT INTO users (first_name, last_name, phone, role, password) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, phone", [Fname, Lname, phone, role, password]);
    return rows;
}

async function addParent(Fname, Lname, phone, role, password, students) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");

        const { rows } = await client.query(
          "INSERT INTO users (first_name, last_name, phone, role, password) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, phone",
          [Fname, Lname, phone, role, password],
        );
        const parentid = rows[0].id;
        for (const student of students) {
          await client.query(
            `
                INSERT INTO students (
                    first_name,
                    parentid,
                    schoolid
                )
                VALUES ($1, $2, $3)
            `,
            [student.first_name,  parentid, student.schoolid],
          );
        }

        await client.query("COMMIT");
        return rows;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
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
    addParent,
    getUserByPhone,
    addRefreshToken,
    checkForRefreshToken,
    deleteRefreshToken,
    getUserById,
    updateTokenVersion,
    checkTokenVersion
}