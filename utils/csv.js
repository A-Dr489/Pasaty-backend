/*
    Turning rows into a CSV a spreadsheet will actually open.

    The whole job is the escaping. A route called "Al Nakheel, North" or a
    parent whose name carries an apostrophe-quote would otherwise split into two
    columns or swallow the rest of the file, and that corruption is silent — the
    spreadsheet opens, it is simply wrong.
*/

//Excel's line ending. \n alone is fine everywhere else and broken there, so
//there is nothing to weigh up.
const NEWLINE = "\r\n";

/*
    One value, quoted only when it has to be.

    A field needs quoting if it contains a comma, a quote or a line break; and
    inside a quoted field, a quote is written twice. Null and undefined become
    an empty cell rather than the words "null" or "undefined", which is what
    `${value}` would produce.
*/
function escapeCell(value) {
    if(value === null || value === undefined) return "";

    const text = String(value);
    if(!/[",\r\n]/.test(text)) return text;

    return `"${text.replaceAll('"', '""')}"`;
}

/*
    columns is [{ key, header }] so the file's column order and its headings are
    decided in one place, and a renamed database column cannot silently reorder
    somebody's spreadsheet.
*/
function toCsv(columns, rows) {
    const head = columns.map((column) => escapeCell(column.header)).join(",");
    const body = rows.map((row) =>
        columns.map((column) => escapeCell(row[column.key])).join(",")
    );

    return [head, ...body].join(NEWLINE) + NEWLINE;
}

module.exports = {
    toCsv,
    escapeCell
}
