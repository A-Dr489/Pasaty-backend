const db = require("../storage/deviceQuery.js");
const { httpError } = require("../utils/functions.js");
const { LANGUAGES, DEFAULT_LANGUAGE } = require("../utils/pushMessages.js");

const PLATFORMS = ["android", "ios"];

/*
    Registers the phone the caller is signed in on, or refreshes what we know
    about it.

    The app calls this after every login and again whenever FCM rotates the
    token. Both are the same operation - store this token against this user -
    so there is one endpoint rather than a create and an update, and calling it
    twice with the same values is harmless.

    The token itself is generated on the device by the FCM SDK, not here. All
    the server does is remember which account it currently belongs to.
*/
exports.registerDevice = async (req, res, next) => {
    try{
        const { token, platform, language } = req.body;

        const cleanToken = token?.trim();
        if(!cleanToken) throw httpError(400, "No device token provided");
        if(!PLATFORMS.includes(platform)) throw httpError(400, "Invalid platform");

        //An unfamiliar locale is not worth rejecting a registration over - the
        //device still needs to be reachable, it just reads English until the
        //app sends something we translate.
        const cleanLanguage = LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;

        await db.upsertDeviceToken(req.user.userid, cleanToken, platform, cleanLanguage);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (registerDevice): " + err);
        next(err);
    }
}

/*
    Unregisters one phone.

    Removing the row does not delete the token on the device - the FCM SDK
    still holds it, and the same string comes back on the next login. All this
    does is give up our ability to send there, which is the whole point when
    somebody signs out.

    A token that was not there is not an error: an app retrying an unregister
    it already completed should get the same answer as the first time.
*/
exports.unregisterDevice = async (req, res, next) => {
    try{
        const cleanToken = req.body?.token?.trim();
        if(!cleanToken) throw httpError(400, "No device token provided");

        await db.deleteDeviceToken(req.user.userid, cleanToken);

        res.json({message: "Done!"});
    } catch(err) {
        console.log("Server Error (unregisterDevice): " + err);
        next(err);
    }
}