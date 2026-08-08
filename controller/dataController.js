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

//Dashboard
const PHASES = ['morning', 'afternoon'];
const MAX_TREND_DAYS = 400;

/* Rejects '2026-13-45' as well as the wrong shape — the Date round-trip is
   what catches a well-formed but impossible date. */
const cleanDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
};

const todayISO = () => new Date().toISOString().slice(0, 10);

exports.getOverview = async (req, res, next) => {
    try{
        const date = cleanDate(req.body.date ?? todayISO());
        const phase = (req.body.phase ?? 'afternoon').toLowerCase();

        if (!date) throw httpError(400, 'Invalid date');
        if (!PHASES.includes(phase)) throw httpError(400, 'Invalid phase');

        const overview = await db.getOverview(date, phase);

        res.json(overview);
    } catch(err) {
        console.log("Server Error (getOverview): " + err);
        next(err);
    }
}

exports.getRouteBoard = async (req, res, next) => {
  try {
    const date = cleanDate(req.body.date ?? todayISO());
    const phase = (req.body.phase ?? 'morning').toLowerCase();

    if (!date) throw httpError(400, 'Invalid date');
    if (!PHASES.includes(phase)) throw httpError(400, 'Invalid phase');

    const routes = await db.getRouteBoard(date, phase);

    res.json(routes);
  } catch (err) {
    console.log('Server Error (getRouteBoard): ' + err);
    next(err);
  }
};

exports.getAttendanceTrend = async (req, res, next) => {
  try {
    const from = cleanDate(req.body.from);
    const to = cleanDate(req.body.to);

    if (!from || !to) throw httpError(400, 'Invalid date range');
    if (from > to) throw httpError(400, 'from must not be after to');

    /* Without a cap, ?from=1900-01-01 scans the whole attendance table. */
    const days = (new Date(to) - new Date(from)) / 86400000;
    if (days > MAX_TREND_DAYS) throw httpError(400, 'Range too large');

    const trend = await db.getAttendanceTrend(from, to);

    res.json(trend);
  } catch (err) {
    console.log('Server Error (getAttendanceTrend): ' + err);
    next(err);
  }
};