const pool = require("./pool.js");
const { ROLE } = require("../utils/enum.js");

/*
    schoolid is only read when the role being created is ROLE.SCHOOL, and then
    it is required: an account of that role with no row in school_account can
    reach every portal endpoint and resolve to no school, which schoolScope
    refuses outright. Creating the two halves separately would leave exactly
    that account behind if the second insert failed, so they go in together or
    not at all.
*/
async function addUser(Fname, Lname, phone, role, password, schoolid = null) {
    if(role !== ROLE.SCHOOL) {
        const { rows } = await pool.query("INSERT INTO users (first_name, last_name, phone, role, password) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, phone", [Fname, Lname, phone, role, password]);
        return rows;
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const { rows } = await client.query(
            "INSERT INTO users (first_name, last_name, phone, role, password) VALUES ($1, $2, $3, $4, $5) RETURNING id, first_name, last_name, phone",
            [Fname, Lname, phone, role, password]
        );
        await client.query(
            "INSERT INTO school_account (userid, schoolid) VALUES ($1, $2)",
            [rows[0].id, schoolid]
        );

        await client.query("COMMIT");
        return rows;
    } catch(e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

/*
    forcedSchoolid is the caller's own school when a school account is doing the
    registering. Every child then lands at that school whatever the body said -
    the school picker is not shown to them, and a request that names another
    school is not a form they can have filled in.

    null for an admin or sub-admin, who pick each child's school themselves.
*/
async function addParent(Fname, Lname, phone, role, password, students, forcedSchoolid = null) {
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
            [student.first_name,  parentid, forcedSchoolid ?? student.schoolid],
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

/*
    Ends one stored session.

    RETURNING userid because logout also unregisters the device, and that has to
    be done as somebody: /v1/auth/logout runs without authenticateUser, so there
    is no req.user to check ownership against. The owner of the refresh token
    being deleted is the one credential the caller actually presented, so it is
    what the device removal is scoped to. No row back means the cookie matched
    nothing and no identity was proven.
*/
async function deleteRefreshToken(token) {
    const { rows } = await pool.query(
        "DELETE FROM refreshtokens WHERE token = $1 RETURNING userid",
        [token]
    );
    return rows[0]?.userid ?? null;
}

async function getUserById(id) {
    const { rows } = await pool.query("SELECT id, first_name, last_name, phone, createdat FROM users WHERE id = $1", [id]);
    return rows;
}

async function updateTokenVersion(id) {
    const { rows } = await pool.query("UPDATE users SET version = version + 1 WHERE id = $1 RETURNING version", [id]);
    return rows;
}

/*
    The two facts every authenticated request needs about its caller: whether
    its token is still the current one, and which school it is confined to.

    Both come from one statement on purpose. This runs on every single request
    already, and the school link is read here rather than baked into the JWT so
    that moving an account to another school - or deleting the school out from
    under it - takes effect on the next request instead of waiting for a
    re-login. A stale scope is the kind of wrong that shows somebody another
    school's children.

    schoolid is null for every role but ROLE.SCHOOL, and null is read as
    "unscoped" only after the role has been checked. See schoolScope.
*/
async function checkTokenVersion(id) {
    const { rows } = await pool.query(`
        SELECT u.version, sa.schoolid
        FROM users u
        LEFT JOIN school_account sa ON sa.userid = u.id
        WHERE u.id = $1
    `, [id]);
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