const ExcelJS = require("exceljs");

/*
    Rows to a spreadsheet, for any export in the portal.

    WHY NOT CSV
    -----------
    CSV is plain text and carries no column widths, so Excel opens every file at
    its default width and any date lands as ###### until the reader widens the
    column by hand. It also carries no types: every cell is a string, and what
    it becomes depends on the reader's locale guessing. A workbook states both.

    HOW DATES AND TIMES ARE WRITTEN
    -------------------------------
    Not as JS Date objects. Values arrive here already formatted in the school's
    timezone by postgres, and handing a Date to a spreadsheet library re-reads it
    through whatever timezone the server happens to be in — which is exactly the
    day-boundary shift the postgres formatting exists to avoid.

    Instead the Excel serial number is computed straight from the digits. A date
    serial is days since 1899-12-30, a time is a fraction of a day, and neither
    calculation involves a timezone at all. The cell is then a real date or time
    that Excel can sort, filter and pivot, showing exactly the digits postgres
    produced.
*/

//Days between Excel's epoch (1899-12-30) and the Unix epoch.
const EXCEL_EPOCH_OFFSET = 25569;
const MS_PER_DAY = 86400000;
const SECONDS_PER_DAY = 86400;

/*
    Sensible reading widths. Narrow enough not to waste the screen, wide enough
    that nothing arrives as ######.

    The minimum is 10 rather than 9 on purpose: exceljs treats exactly 9 as its
    own internal default and omits it from the file, so the column silently
    falls back to Excel's 8.43 instead of the width that was asked for.
*/
const MIN_WIDTH = 10;
const MAX_WIDTH = 44;
const WIDTH_PADDING = 2;

const FORMATS = {
    date: "yyyy-mm-dd",
    time: "hh:mm:ss"
};

//"2026-08-11" -> the number Excel stores for that day.
function dateSerial(value) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if(!parts) return null;

    const [, year, month, day] = parts;
    return Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY + EXCEL_EPOCH_OFFSET;
}

//"20:20:24" -> the fraction of a day Excel stores for that clock time.
function timeSerial(value) {
    const parts = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if(!parts) return null;

    const [, hours, minutes, seconds] = parts;
    return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) / SECONDS_PER_DAY;
}

/*
    A cell's value in the type its column declares.

    Anything that fails to parse falls through as the original text rather than
    being dropped: a malformed value is worth seeing in the export, and silently
    blanking it would hide the problem instead of reporting it.
*/
function cellValue(type, value) {
    if(value === null || value === undefined || value === '') return null;

    if(type === "date") return dateSerial(value) ?? value;
    if(type === "time") return timeSerial(value) ?? value;
    if(type === "number") {
        const number = Number(value);
        return Number.isFinite(number) ? number : value;
    }

    return String(value);
}

//What the column will look like once Excel has formatted it, which is not the
//same as the raw value: a date arrives as "2026-08-11" but is stored as a
//number, so its width comes from the format rather than from the data.
function displayWidth(column, rows) {
    if(column.width) return column.width;

    const formatted = column.type === "date" ? FORMATS.date.length
        : column.type === "time" ? FORMATS.time.length
        : 0;

    const longest = rows.reduce((widest, row) => {
        const value = row[column.key];
        const length = value === null || value === undefined ? 0 : String(value).length;
        return Math.max(widest, length);
    }, Math.max(formatted, String(column.header).length));

    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + WIDTH_PADDING));
}

//Excel refuses these in a sheet name and caps it at 31 characters, and it fails
//on open rather than warning.
function safeSheetName(name) {
    const clean = String(name ?? "Sheet1").replace(/[[\]:*?/\\]/g, " ").trim();
    return clean.slice(0, 31) || "Sheet1";
}

/*
    Builds the workbook and returns it as a buffer ready to send.

    columns is [{ key, header, type, width }] — the same shape the CSV writer
    took, plus a type. Declaring the order and the headings in one place means a
    renamed database column cannot silently reorder somebody's spreadsheet.
*/
async function toWorkbookBuffer({ sheetName, columns, rows }) {
    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(safeSheetName(sheetName));

    sheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: displayWidth(column, rows),
        style: FORMATS[column.type] ? { numFmt: FORMATS[column.type] } : {}
    }));

    for(const row of rows) {
        const values = {};
        for(const column of columns) {
            values[column.key] = cellValue(column.type, row[column.key]);
        }
        sheet.addRow(values);
    }

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEFEFEF" }
    };
    header.alignment = { vertical: "middle" };

    //Frozen so the headings stay while a long export is scrolled, and filtered
    //so a reader can narrow it without building the filter themselves.
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length }
    };

    return workbook.xlsx.writeBuffer();
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

module.exports = {
    toWorkbookBuffer,
    XLSX_CONTENT_TYPE,
    dateSerial,
    timeSerial
}
