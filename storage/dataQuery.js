const pool = require("./pool.js");

async function addSchool(name, supervisor, supervisor_phone, city) {
    const { rows } = await pool.query(`
        INSERT INTO school (name, supervisor, supervisor_phone, city)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
    `, [name, supervisor, supervisor_phone, city]);

    return rows.length === 0
}

async function searchSchoolByName(name) {
    const cleanName = `%${name}%`;
    const { rows } = await pool.query(`
        SELECT id, name AS school_name
        FROM school
        WHERE name ILIKE $1
        LIMIT 10;
    `, [cleanName]);
    return rows;
}

async function getSchools() {
    const { rows } = await pool.query("SELECT * FROM school");
    return rows;
}

async function updateSchool(schoolid, name, supervisor, phone, city) {
    await pool.query(`
        UPDATE school 
        SET name = $2, supervisor = $3, supervisor_phone = $4, city = $5
        WHERE id = $1
    `, [schoolid, name, supervisor, phone, city]);
}

module.exports = {
    addSchool,
    searchSchoolByName,
    getSchools,
    updateSchool
}