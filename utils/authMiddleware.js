const { verifyAccessToken } = require("./jwtTools.js");
const db = require("../storage/authenticationQuery.js");

async function authenticateUser(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Access token required' });
    }

    const decoded = verifyAccessToken(token);
    if (!decoded) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }

    try {
        const rows = await db.checkTokenVersion(decoded.userid);

        if(rows.length === 0) {
            return res.status(401).json({ message: 'User not found' });
        }
        
        if (decoded.version !== rows[0].version) {
            return res.status(401).json({ 
                message: 'Session terminated. Please login again.',
                code: 'SESSION_TERMINATED'
            });
        }

        req.user = decoded;
        next();
    } catch(e) {
        console.log('Server Error (authentication middleware):' + e);
        res.status(500).json({ message: 'Internal Server error' });
    }
}

async function authenticateSocket(socket, next) {
    const token = socket.handshake.auth.token;

    if(!token) {
        next(new Error('Authentication required'));
    }

    try {
        const decoded = verifyAccessToken(token);
        const rows = await db.checkTokenVersion(decoded.userid);

        if(rows.length === 0) {
            return res.status(401).json({ message: 'User not found' });
        }
        if (decoded.token_version !== rows[0].token_version) {
            return res.status(401).json({ 
                message: 'Session terminated. Please login again.',
                code: 'SESSION_TERMINATED'
            });
        }

        socket.user = decoded;
        next();
    } catch(e) {
        next(new Error("Invalid Token Or expired"));
    }
}

const requiredRole = (...allowedRoles) => {
    return (req, res, next) => {
        if(!req.user) {
            return res.status(401).json({message: "Authentication required!"});
        }

        if(!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({message: "Access denied, Incorrect Role"});
        }

        next();
    }
}

module.exports = {
    authenticateUser,
    authenticateSocket,
    requiredRole
}