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

function verifyRefreshToken(token) {
    try{
        return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
        return null; // Token invalid or expired
    }
}

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    verifyAccessToken,
    verifyRefreshToken
}