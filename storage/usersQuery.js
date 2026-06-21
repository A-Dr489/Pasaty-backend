const pool = require("./pool.js");

//Returns all the users except yourself (Admin)
async function getAllUsers(id) {
    const { rows } = await pool.query("SELECT * FROM users WHERE id <> $1", [id]);
    return rows;
}

async function getStudentFromParentId(parentid) {
    const { rows } = await pool.query("SELECT * FROM students WHERE parentid = $1", [parentid]);
    return rows;
}

async function updateUser(userid, Fname, Lname, phone, role, students) {
    const client = await pool.connect();
    try{
        await client.query("BEGIN");

        await client.query(
          "UPDATE users SET first_name = $1, last_name = $2, phone = $3, role = $4 WHERE id = $5",
          [Fname, Lname, phone, role, userid],
        );
        
        for (const student of students) {
          await client.query(
            `
                INSERT INTO students (
                    first_name,
                    parentid
                )
                VALUES ($1, $2)
            `,
            [student.first_name, userid],
          );
        }

        await client.query("COMMIT");
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

async function deleteStudentById(id) {
    await pool.query("DELETE FROM students WHERE id = $1", [id]);
}

async function deleteUserById(userid) {
    await pool.query("DELETE FROM users WHERE id = $1", [userid]);
}

async function searchByPhone(phone) {
    const cleanQuery = `%${phone}%`;
    const { rows } = await pool.query(`
        SELECT id, first_name, last_name, phone, role 
        FROM users 
        WHERE phone ILIKE $1
    `, [cleanQuery]);
    
    return rows;
}

async function searchByString(query) {
    const cleanQuery = `%${query}%`;
    const { rows } = await pool.query(`
        SELECT id, first_name, last_name, phone, role
        FROM users
        WHERE first_name ILIKE $1
        OR last_name ILIKE $1
        OR CONCAT(first_name, ' ', last_name) ILIKE $1
    `, [cleanQuery]);

    return rows;
}

module.exports = {
    getAllUsers,
    getStudentFromParentId,
    updateUser,
    deleteStudentById,
    deleteUserById,
    searchByPhone,
    searchByString
}