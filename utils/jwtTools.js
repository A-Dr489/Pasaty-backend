const jwt = require("jsonwebtoken");

function generateAccessToken(payload) {
    return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {expiresIn: "15m"});
}

function generateRefreshToken(payload) {
    return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {expiresIn: "15d"});
}

function verifyAccessToken(token) {
    try{
        return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
        return null; // Token invalid or expired
    }
}

/*
    Why a refresh token failed, not only that it did.

    verifyRefreshToken collapses "ran out" and "does not verify" into one null,
    which is everything postRefresh needs to decide the ANSWER - both are a 403.
    It is not enough to decide whether to delete the row behind it. An expired
    token is dead for good and its row is landfill. A signature failure is what
    every token in the table would report if REFRESH_TOKEN_SECRET were rotated
    or misconfigured, and treating that as a dead row would sign out every
    account on the service at once.

    The same distinction push.js draws between a token FCM rejected and a
    message FCM rejected: a per-row failure and a systemic one look identical
    until you read the reason.
*/
function inspectRefreshToken(token) {
    try{
        return { payload: jwt.verify(token, process.env.REFRESH_TOKEN_SECRET), expired: false };
    } catch (err) {
        return { payload: null, expired: err.name === "TokenExpiredError" };
    }
}

//The verdict on its own, for a caller that does not care why. Kept so the pair
//with verifyAccessToken still reads the same, and delegating so there is only
//one place a refresh token is ever verified.
function verifyRefreshToken(token) {
    return inspectRefreshToken(token).payload;
}

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    inspectRefreshToken
}
//just to deploy