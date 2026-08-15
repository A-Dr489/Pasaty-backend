const pool = require("./pool.js");

/*
    Device tokens — the only addresses FCM will accept.

    A row is one app install on one phone. It is not a property of a person:
    one parent may carry two devices, and one device may be handed to somebody
    else, so this is a table rather than a column on users.

    UNIQUE (token) on the table is what makes the handover safe. The insert
    below conflicts on it and reassigns userid, so a token can only ever belong
    to one account at a time and the previous owner stops receiving another
    family's notifications the moment the new one signs in.
*/
async function upsertDeviceToken(userid, token, platform, language) {
    await pool.query(`
        INSERT INTO device_tokens (userid, token, platform, language)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (token) DO UPDATE
        SET userid = EXCLUDED.userid,
            platform = EXCLUDED.platform,
            language = EXCLUDED.language,
            last_seen = now()
    `, [userid, token, platform, language]);
}

/*
    Unregisters one device.

    userid is in the WHERE beside the token so a caller can only ever remove
    its own device. That matters most on logout, which is reached without the
    access token - see authController.postLogout.

    Returns whether anything matched, so a caller can tell "removed" from
    "there was nothing there", though neither is an error.
*/
async function deleteDeviceToken(userid, token) {
    const { rowCount } = await pool.query(
        "DELETE FROM device_tokens WHERE token = $1 AND userid = $2",
        [token, userid]
    );
    return rowCount > 0;
}

/*
    Every device belonging to any of these users.

    language rides along because the server composes the text: two parents on
    the same route can want the same event in different languages, so the send
    is grouped by it rather than by user.

    The id comes back so a token that FCM rejects can be deleted by primary key
    instead of by matching the string again.
*/
async function getTokensForUsers(userids) {
    if(userids.length === 0) return [];

    const { rows } = await pool.query(`
        SELECT id, userid, token, language
        FROM device_tokens
        WHERE userid = ANY($1::int[])
    `, [userids]);

    return rows;
}

//Drops tokens FCM has told us are dead. See utils/push.js for which failures
//count as dead and which emphatically do not.
async function deleteTokensByIds(ids) {
    if(ids.length === 0) return 0;

    const { rowCount } = await pool.query(
        "DELETE FROM device_tokens WHERE id = ANY($1::int[])",
        [ids]
    );
    return rowCount;
}

/*
    Who to notify about something that happened to a whole route, plus the
    route's name for the notification title.

    The join to users is an inner join on purpose: a student with no parent
    attached has nobody to notify, so they belong outside this result. (That
    those students exist at all is a roster problem, not a notification one.)

    DISTINCT because a parent with two children on the route is still one
    person and must not be pushed twice.
*/
async function getRouteRecipients(routeid) {
    const { rows } = await pool.query(`
        SELECT DISTINCT u.id AS userid, r.name AS route_name
        FROM students s
        JOIN users u ON u.id = s.parentid
        JOIN routes r ON r.id = s.routeid
        WHERE s.routeid = $1
    `, [routeid]);

    return rows;
}

module.exports = {
    upsertDeviceToken,
    deleteDeviceToken,
    getTokensForUsers,
    deleteTokensByIds,
    getRouteRecipients
}