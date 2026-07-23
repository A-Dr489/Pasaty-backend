const { httpError } = require("../utils/functions.js");
const db = require("../storage/dataQuery.js");

exports.createSchool = async (req, res, next) => {
    try{
        const { name, supervisor, supervisor_phone, city } = req.body;
        if(!name) throw httpError(400, "Invalid Name");
        if(!city) throw httpError(400, "Invalid City");

        const result = await db.addSchool(name, supervisor, supervisor_phone, city);
        if(result) throw httpError(409, "This school name already exists");

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (createSchool): " + err);
        next(err);
    }
}

exports.searchSchool = async (req, res, next) => {
    try{
        const name = req.params.name;
        const search = name?.trim();
        if(!name || !search) throw httpError(400, "School name was not provided");
        
        const rows = await db.searchSchoolByName(search);
        if(rows.length === 0) throw httpError(400, "No school found");

        res.json({result: rows});
    } catch(err) {
        console.log("Server Error (searchSchool): " + err);
        next(err);
    }
}

exports.getAllSchools = async (req, res, next) => {
    try{
        const rows = await db.getSchools();
        if(rows.length === 0) throw httpError(404, "No schools found");

        res.json({schools: rows});
    } catch(err) {
        console.log("Server Error (getAllSchools): " + err);
        next(err);
    }
}

exports.updateSchool = async (req, res, next) => {
    try{
        const { name, supervisor, supervisor_phone, city} = req.body;
        const cleanName = name?.trim();
        const cleanSupervisor = supervisor?.trim();
        const schoolid = Number(req.params.schoolid);
        if (!Number.isInteger(schoolid)) throw httpError(400, 'Invalid school ID');
        if(!cleanName || !cleanSupervisor || !supervisor_phone || !city) throw httpError(400, "Insufficient Data");

        await db.updateSchool(schoolid, cleanName, cleanSupervisor, supervisor_phone, city);

        res.json({message: "Done!"});
    } catch(e) {
        console.log("Server Error (updateSchool): " + err);
        next(err);
    }
}