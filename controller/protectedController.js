const db = require("../storage/protectedQuery.js");

exports.getProfile = async (req, res) => {
    try{
        const rows = await db.getUserById(req.user.userid);
        
        if(rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        res.send({user: rows[0]})
    } catch(e) {
        console.log("Server Error (getProfile): " + e);
        res.status(500).json({message: "Internal Server Error"});
    }
}