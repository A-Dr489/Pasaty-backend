const bcrypt = require("bcryptjs");
const db = require("../storage/authenticationQuery.js");
const deviceDb = require("../storage/deviceQuery.js");
const { body, validationResult } = require("express-validator");
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require("../utils/jwtTools.js");
const { ROLE } = require("../utils/enum.js");
const { canGrantRole } = require("../utils/functions.js");

const validatorRegister = [
    body("Fname").trim()
    .notEmpty().withMessage("First name is required")
    .isLength({min: 3, max: 50}).withMessage("First name must be 3 - 50 character"),

    body("Lname").trim()
    .notEmpty().withMessage("Last name is required")
    .isLength({min: 3, max: 50}).withMessage("Last name must be 3 - 50 character"),

    body("phone").trim()
    .notEmpty().withMessage("phone is required")
    .isLength({min: 11, max: 14}).withMessage("phone must be 11 - 14 character"),

    body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),

    body("Cpassword")
    .notEmpty().withMessage("Confirm-Password is required")
    .custom((value, { req }) => {
        if(value !== req.body.password) {
            throw new Error("Passwords do not match");
        } else {
            return true;
        }
    }),

    /*
        The role was previously taken on trust and written straight into the
        row, so any string at all became a role - and a typo'd one would have
        matched no guard anywhere, leaving an account that could not be
        repaired from the portal because no filter would list it.
    */
    body("role").trim()
    .notEmpty().withMessage("Role is required")
    .isIn(Object.values(ROLE)).withMessage("Invalid role")
]

const validatorLogin = [
    body("phone")
    .notEmpty().withMessage("phone is required")
    .isLength({min: 11, max: 14}).withMessage("phone must be 11 - 14 character"),
    
    body("password")
    .notEmpty().withMessage("Password is required")
]

exports.postRegister = [validatorRegister, async (req, res) => {
    //express-validator
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const formattedErrors = {};
        errors.array().forEach((err) => {
            formattedErrors[err.path] = err.msg;
        });

        return res.status(400).json({ errors: formattedErrors });   //400: bad request
    }

    /*
        Which roles this caller may hand out depends on who they are, which the
        validator chain above cannot see - it is only ever shown the body.

        Answered in the same { errors } shape the validators use, so the form
        renders it against the Role select like any other field error rather
        than needing a second error path of its own.
    */
    if(!canGrantRole(req.user.role, req.body.role)) {
        return res.status(403).json({
            errors: { role: "Only an admin can create an admin or sub-admin account" }
        });
    }

    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);

        let rows; 
        if(req.body.students.length === 0 && req.body.role !== ROLE.PARENT) {
            rows = await db.addUser(req.body.Fname, req.body.Lname, req.body.phone, req.body.role, hashedPassword); 
        } else {
            rows = await db.addParent(req.body.Fname, req.body.Lname, req.body.phone, req.body.role, hashedPassword, req.body.students);
        }
        res.status(201).json({
            message: "Account created successfully",
            user: rows[0]
        })
    } catch(e) {
        console.log("Server Error (register): " + e);
        res.status(500).json({message: "Internal server error" });
    }
}]

exports.postLogin = [validatorLogin, async (req, res) => {
    //express-validator
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const formattedErrors = {};

        errors.array().forEach((err) => {
            formattedErrors[err.path] = err.msg;
        });

        return res.status(400).json({ errors: formattedErrors });
    }
    //login code
    try{
        const rows = await db.getUserByPhone(req.body.phone);

        if(rows.length === 0) {
            return res.status(401).json({message: "Invalid Credentials"});
        }

        const match = await bcrypt.compare(req.body.password, rows[0].password);
        if(!match) {
            return res.status(401).json({message: "Invalid Credentials"});
        }

        const versionToken = await db.updateTokenVersion(rows[0].id);

        const accessToken = generateAccessToken({userid: rows[0].id, version: versionToken[0].version, role: rows[0].role});
        const refreshToken = generateRefreshToken({userid: rows[0].id, version: versionToken[0].version, role: rows[0].role});

        await db.addRefreshToken(rows[0].id, refreshToken, new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 15 * 24 * 60 * 60 * 1000
        });

        /*
            Same shape as GET /v1/protected/profile, so the client holds one
            user object whether it has just signed in or just refreshed. It
            previously returned Fname/Lname and no role, which meant anything
            reading the user had to know which of the two calls produced it.

            Listed field by field rather than spread: getUserByPhone does a
            SELECT *, so the row still carries the password hash.
        */
        res.json({
            accessToken: accessToken,
            user: {
                id: rows[0].id,
                first_name: rows[0].first_name,
                last_name: rows[0].last_name,
                phone: rows[0].phone,
                role: rows[0].role,
                createdat: rows[0].createdat
            }
        })
    } catch(e) {
        console.log("Server Error (login): " + e);
        res.status(500).json({message: "Internal server error" });
    }
}]

//refreshes the access token
exports.postRefresh = async (req, res) => {
    try {
        const { refreshToken } = req.cookies;
        if (!refreshToken) {
            return res.status(401).json({ message: 'Refresh token not found' });
        }

        const decoded = verifyRefreshToken(refreshToken);
        if (!decoded) {
            return res.status(403).json({ message: 'Invalid refresh token' });
        }

        const rows = await db.checkForRefreshToken(refreshToken, decoded.userid);
        if (rows.length === 0) {
            return res.status(403).json({ message: 'Refresh token revoked' });
        }

        /*
            The account's current version, not the one baked into this token.

            Logging in bumps users.version, which is what makes this system
            single-session: every access token issued before that stops being
            accepted. But a login only ADDS a refresh token row, it does not
            remove the old device's - so the check above still passed for a
            superseded session, and this endpoint handed back a brand new access
            token stamped with the OLD version. authenticateUser then rejected
            that token on every request, and because refreshing had "worked" the
            client was never told the session was over: the old phone sat there
            erroring instead of returning to the login screen.

            The row is deleted on the way out. It can never produce a usable
            token again, so leaving it would mean the table quietly filling with
            dead sessions and this branch being re-run for each one.
        */
        const current = await db.checkTokenVersion(decoded.userid);
        if (current.length === 0) {
            return res.status(403).json({ message: 'User not found' });
        }

        if (decoded.version !== current[0].version) {
            await db.deleteRefreshToken(refreshToken);
            //Same code authenticateUser sends, so a client only has to learn
            //one signal for "this session is finished, sign in again".
            return res.status(403).json({
                message: 'Session terminated. Please login again.',
                code: 'SESSION_TERMINATED'
            });
        }

        const accessToken = generateAccessToken({userid: decoded.userid, version: decoded.version, role: decoded.role});

        res.json({ accessToken: accessToken });
    } catch(e) {
        console.log("Server Error (refresh): " + e);
        res.status(500).json({message: "Internal server error" });
    }
}

/*
    Ends the session and, if the app sent one, unregisters the phone.

    The device token has to go with the logout: leaving the row behind means
    the next person to sign in on that handset keeps receiving notifications
    about another family's children until something else overwrites it.

    Ownership is taken from the refresh token, not from the request body. This
    endpoint runs without authenticateUser - there is no req.user here - so the
    userid returned by deleting the refresh token row is the only identity the
    caller has actually proven. Without it, a body containing a device token
    would let anyone unregister any phone whose token they had seen.

    A logout with no valid cookie therefore still clears the session client-side
    but leaves the device row alone: there is nobody to attribute it to.
*/
exports.postLogout = async (req, res) => {
    try {
        const { refreshToken } = req.cookies;
        if(refreshToken) {
            const userid = await db.deleteRefreshToken(refreshToken);

            const deviceToken = req.body?.device_token?.trim();
            if(userid && deviceToken) {
                await deviceDb.deleteDeviceToken(userid, deviceToken);
            }
        }

        res.clearCookie("refreshToken");
        res.json({ message: 'Logged out successfully' });
    } catch(e) {
        console.log("Server Error (logout): " + e);
        res.status(500).json({message: "Internal server error" });
    }
}