const bcrypt = require("bcryptjs");
const db = require("../storage/authenticationQuery.js");
const { body, validationResult } = require("express-validator");
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require("../utils/jwtTools.js");

const validatorRegister = [
    body("name").trim()
    .notEmpty().withMessage("name is required")
    .isLength({min: 3, max: 50}).withMessage("name must be 3 - 50 character"),

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
    })
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

    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);

        const rows = await db.addUser(req.body.name, req.body.phone, hashedPassword);
        res.status(201).json({
            message: "Account created succesfully",
            user: rows[0]
        })
    } catch(e) {
        console.log("Server Error (register): " + e);
        res.status(500).json({message: "Internal server error " + e.message});
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
            sameSite: 'strict',
            maxAge: 15 * 24 * 60 * 60 * 1000
        });

        res.json({
            accessToken: accessToken,
            user: {id: rows[0].id, name: rows[0].name, phone: rows[0].phone}
        })
    } catch(e) {
        console.log("Server Error (login): " + e);
        res.status(500).json({message: "Internal server error " + e.message});
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

        const accessToken = generateAccessToken({userid: decoded.userid, version: decoded.version, role: decoded.role});

        res.json({ accessToken: accessToken });
    } catch(e) {
        console.log("Server Error (refresh): " + e);
        res.status(500).json({message: "Internal server error " + e.message});
    }
}

exports.postLogout = async (req, res) => {
    try {
        const { refreshToken } = req.cookies;
        if(refreshToken) {
            await db.deleteRefreshToken(refreshToken);
        }

        res.clearCookie("refreshToken");
        res.json({ message: 'Logged out successfully' });
    } catch(e) {
        console.log("Server Error (logout): " + e);
        res.status(500).json({message: "Internal server error " + e.message});
    }
}