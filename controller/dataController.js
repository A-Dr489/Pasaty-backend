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