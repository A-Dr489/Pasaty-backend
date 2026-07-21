const pool = require("./pool.js");

//Returns all the users except yourself (Admin)
async function getAllUsers(id) {
    const { rows } = await pool.query("SELECT * FROM users WHERE id <> $1", [id]);
    return rows;
}

async function getStudentFromParentId(parentid) {
    const { rows } = await pool.query(`
        SELECT s.*, sk.name AS school_name
        FROM students s
        LEFT JOIN school sk ON s.schoolid = sk.id
        WHERE parentid = $1
    `, [parentid]);
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
                    parentid,
                    schoolid
                )
                VALUES ($1, $2, $3)
            `,
            [student.first_name, userid, student.schoolid],
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
    const { rowCount } = await pool.query(`
        DELETE FROM students s 
        WHERE id = $1
        AND NOT EXISTS (
            SELECT 1
            FROM waypoints w
            WHERE w.studentid = s.id
        )`
    , [id]);

    return rowCount > 0;
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

async function getAllStudents() {
    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.parentid, s.routeid, s.schoolid, sk.name AS school_name,
        CONCAT(u.first_name, ' ', u.last_name) AS parent_name,
        u.phone
        FROM students s
        JOIN users u ON s.parentid = u.id
        LEFT JOIN school sk ON s.schoolid = sk.id
    `);

    return rows;
}

async function updateStudent(studentid, first_name, schoolid) {
    await pool.query("UPDATE students SET first_name = $2, schoolid = $3 WHERE id = $1", [studentid, first_name, schoolid]);
}

async function searchStudent(query) {
    const cleanQuery = `%${query}%`;
    const { rows } = await pool.query(`
        SELECT s.id, s.first_name, s.routeid, s.parentid,
        u.first_name AS parent_first, u.last_name AS parent_last, CONCAT(u.first_name, ' ', u.last_name) AS parent_name, u.phone
        FROM students s
        LEFT JOIN users u ON u.id = s.parentid
        WHERE s.first_name ILIKE $1
         OR u.first_name ILIKE $1
         OR u.last_name ILIKE $1
         OR CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        ORDER BY s.id
    `, [cleanQuery]);

    return rows;
}

async function searchParentName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT u.id, CONCAT(u.first_name, ' ', u.last_name) as full_name, phone
        FROM users u
        WHERE CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        AND u.role = 'parent'
        LIMIT 10;
    `, [cleanName]);
    return rows;
}

async function updateStudentParent(parentid, studentid) {
    await pool.query("UPDATE students SET parentid = $1 WHERE id = $2", [parentid, studentid]);
}

module.exports = {
    getAllUsers,
    getStudentFromParentId,
    updateUser,
    deleteStudentById,
    deleteUserById,
    searchByPhone,
    searchByString,
    getAllStudents,
    updateStudent,
    searchStudent,
    searchParentName,
    updateStudentParent
}