const { httpError } = require("./functions.js");

/*
    Keyset pagination, shared by every list the admin portal scrolls.

    WHY KEYSET AND NOT OFFSET
    -------------------------
    The portal deletes rows straight out of the list it is showing, and new
    users, students and routes are created while an admin is scrolling. With
    OFFSET, deleting one row above the fold pulls every later row up by one, so
    the next page starts one row late and that row is never seen; inserting one
    does the opposite and shows a row twice. A cursor is a position in the data
    rather than a count of rows, so neither can happen.

    The cursor is simply the id of the last row already sent, and every list is
    ordered by id DESC (newest first). ids are unique and never reused, which is
    what makes the ordering total - two rows can never tie and land on the wrong
    side of the cursor.
*/

const DEFAULT_LIMIT = 20;
//A caller asking for more than this is either a mistake or an attempt to pull
//the whole table in one request; either way it gets clamped, not obeyed.
const MAX_LIMIT = 100;

/*
    Reads ?limit= and ?cursor= off a request.

    An absent cursor means "start at the beginning" - that is a normal first
    page, not an error. A cursor that is present but not a number is an error,
    because silently starting over would quietly repeat rows the client has.
*/
function readLimit(query) {
    const requested = Number(query.limit);
    return Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_LIMIT)
        : DEFAULT_LIMIT;
}

function readPage(query) {
    const limit = readLimit(query);

    const raw = query.cursor;
    if(raw === undefined || raw === '') return { limit, cursor: null };

    const cursor = Number(raw);
    if(!Number.isInteger(cursor)) throw httpError(400, "Invalid cursor");

    return { limit, cursor };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/*
    The same thing for a list ordered by day rather than by id.

    A student's attendance history is one row per date, and it has to read
    strictly newest-first. Paging it on id would order it by when the row was
    created instead - normally the same thing, but restarting an old trip
    deletes and recreates that day's rows, which would then surface at the top
    of the history as if they were the most recent day.

    The cursor is the last date already sent, as YYYY-MM-DD. It stays a string
    the whole way through: turning it into a Date and back is what introduces
    a timezone shift, and a history that is off by one day is worse than one
    that will not page.
*/
function readDatePage(query) {
    const limit = readLimit(query);

    const raw = query.cursor;
    if(raw === undefined || raw === '') return { limit, cursor: null };
    if(!DATE_ONLY.test(raw)) throw httpError(400, "Invalid cursor");

    return { limit, cursor: raw };
}

const DATE_AND_ID = /^(\d{4}-\d{2}-\d{2})_(\d+)$/;

/*
    A cursor for a list ordered by day where many rows share the same day.

    One student's history has a single row per date, so the date alone is a
    position in it. A whole school's does not: hundreds of children share every
    date, and "give me everything before 2026-08-11" would skip the rest of the
    11th along with it. The position therefore needs a tiebreaker, which is the
    row id — unique, and stable in the same direction as the date.

    Written as "YYYY-MM-DD_<id>" so it survives a query string unescaped, and
    read back as a pair the query compares as a whole:

        WHERE (a.attendance_date, a.id) < ($date, $id)
*/
function readDateIdPage(query) {
    const limit = readLimit(query);

    const raw = query.cursor;
    if(raw === undefined || raw === '') return { limit, cursor: null };

    const parts = DATE_AND_ID.exec(raw);
    if(!parts) throw httpError(400, "Invalid cursor");

    return { limit, cursor: { date: parts[1], id: Number(parts[2]) } };
}

//The other half of the pair: how a row is turned back into that cursor.
function dateIdCursor(row) {
    return `${row.attendance_date}_${row.id}`;
}

/*
    An optional YYYY-MM-DD bound from a query string, for a from/to filter.

    Absent means unbounded rather than invalid — a range with no start is a
    normal way to ask for "everything up to here".
*/
function readDateFilter(value, label) {
    if(value === undefined || value === '') return null;
    if(!DATE_ONLY.test(value)) throw httpError(400, `Invalid ${label} date`);

    return value;
}

/*
    Turns limit + 1 rows into one page.

    Every query asks for one row more than the client wants. If that extra row
    came back there is at least one more page, and it is dropped from the
    response. This is what lets hasMore be an answer rather than a guess: the
    alternative - "a full page probably means more" - reports a further page
    that does not exist whenever the table divides exactly by the page size.
*/
function buildPage(rows, limit, cursorKey = "id") {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    /*
        cursorKey names the position in whatever order the query used, so the
        cursor can never be a value that sorts differently from the list. It is
        a column name for the simple cases and a function when the position
        takes more than one column — see dateIdCursor.
    */
    const readCursor = typeof cursorKey === "function"
        ? cursorKey
        : (row) => row[cursorKey];

    return {
        items: items,
        hasMore: hasMore,
        nextCursor: hasMore && last ? readCursor(last) : null
    };
}

/*
    An id filter from a query string, in the three states a dropdown can be in.

    null   - the parameter was absent: do not filter on it at all.
    'none' - the "Unassigned" option: match rows where the column IS NULL.
    number - a real id.

    'none' is a word rather than an empty string because an empty string is
    what an untouched <select> sends, and those two must not mean the same
    thing: one asks for everything, the other asks for the rows with nothing
    attached.
*/
function readIdFilter(value, label) {
    if(value === undefined || value === '') return null;
    if(value === 'none') return 'none';

    const id = Number(value);
    if(!Number.isInteger(id)) throw httpError(400, `Invalid ${label}`);

    return id;
}

//An empty filter set is a legitimate query (the unfiltered first page), so the
//keyword has to disappear with the conditions.
function whereClause(parts) {
    return parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    readPage,
    readDatePage,
    readDateIdPage,
    dateIdCursor,
    readDateFilter,
    buildPage,
    readIdFilter,
    whereClause
}