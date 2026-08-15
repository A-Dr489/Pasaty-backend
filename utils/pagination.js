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
function readPage(query) {
    const requested = Number(query.limit);
    const limit = Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const raw = query.cursor;
    if(raw === undefined || raw === '') return { limit, cursor: null };

    const cursor = Number(raw);
    if(!Number.isInteger(cursor)) throw httpError(400, "Invalid cursor");

    return { limit, cursor };
}

/*
    Turns limit + 1 rows into one page.

    Every query asks for one row more than the client wants. If that extra row
    came back there is at least one more page, and it is dropped from the
    response. This is what lets hasMore be an answer rather than a guess: the
    alternative - "a full page probably means more" - reports a further page
    that does not exist whenever the table divides exactly by the page size.
*/
function buildPage(rows, limit) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
        items: items,
        hasMore: hasMore,
        nextCursor: hasMore && last ? last.id : null
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
    buildPage,
    readIdFilter,
    whereClause
}