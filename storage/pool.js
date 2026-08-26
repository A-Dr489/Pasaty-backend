const { Pool } = require("pg");

/*
    SSL is not configured here on purpose. Connecting over Railway's internal
    network does not need it, and anything external should be asking for it in
    DATABASE_URL itself (?sslmode=require) rather than having it forced from
    code, where it would be easy to end up with rejectUnauthorized turned off
    and no longer be verifying anything.
*/
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    /*
        Instances x max must stay under the database's own connection limit. One
        instance at 10 is the library default and is plenty for this traffic;
        raising it is the wrong first move if the app ever feels slow, because
        the queries queue in the pool for a reason.
    */
    max: 10,

    //Hand an idle connection back rather than holding it open all night.
    idleTimeoutMillis: 30000,

    /*
        The important one. The default is 0, meaning wait forever: if the
        database is unreachable or every connection is busy, requests hang until
        the client gives up, and nothing in the logs says why. Five seconds
        turns that into an error that surfaces.
    */
    connectionTimeoutMillis: 5000
});

/*
    Required, not optional. A connection sitting idle in the pool can be dropped
    by the database restarting or by the network - and because that error
    arrives on the pool rather than inside anyone's query, an unhandled 'error'
    event here is an uncaught exception, which takes the whole process down.

    Logging it is enough: the pool discards the dead client and the next query
    opens a new one.
*/
pool.on("error", (err) => {
    console.log("Database Error (idle client): " + err.message);
});

module.exports = pool;