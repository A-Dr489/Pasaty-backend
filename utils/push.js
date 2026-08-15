const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging, MessagingErrorCode } = require("firebase-admin/messaging");
const db = require("../storage/deviceQuery.js");
const { composeText, DEFAULT_LANGUAGE } = require("./pushMessages.js");

/*
    Sending a push, and forgetting the phones that no longer exist.

    Note the import style: firebase-admin v14 removed the old namespaced API,
    so `admin.credential.cert()` and `admin.messaging()` no longer exist and
    throw "Cannot read properties of undefined". The modular entry points above
    are the current surface.

    NOTHING IN HERE MAY THROW INTO A REQUEST
    ----------------------------------------
    By the time a push is sent the attendance row is committed and the socket
    event is out. A notification is a courtesy on top of that, so a dead token,
    a missing credential or an FCM outage must never turn a driver's successful
    tap into an error. Every path below ends in a log line, and notify() is
    called without await so FCM's latency is not added to the driver's request.
*/

//sendEachForMulticast refuses more than this many tokens in one call.
const MAX_TOKENS_PER_SEND = 500;

let messaging = null;
let initialised = false;

/*
    Set up on first use, from the service account JSON in the environment.

    A missing credential disables push rather than crashing the process. The
    server has to keep running without it - locally, in tests, and on any
    deploy where the variable has not been set yet - and an attendance API that
    refuses to boot because notifications are unconfigured would be a far worse
    failure than silence.
*/
function getMessagingClient() {
    if(initialised) return messaging;
    initialised = true;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if(!raw) {
        console.log("Push disabled: FIREBASE_SERVICE_ACCOUNT is not set");
        return null;
    }

    try {
        const app = getApps().length > 0
            ? getApps()[0]
            : initializeApp({ credential: cert(JSON.parse(raw)) });

        messaging = getMessaging(app);
        console.log("Push enabled");
    } catch(e) {
        //Almost always malformed JSON: on Railway the whole key has to be on
        //one line, and a pasted newline breaks the parse.
        console.log("Push disabled, could not read FIREBASE_SERVICE_ACCOUNT: " + e.message);
        messaging = null;
    }

    return messaging;
}

//FCM rejects any data value that is not a string, so numbers are converted and
//anything absent is dropped rather than sent as null.
function stringifyData(data) {
    const clean = {};
    for(const [key, value] of Object.entries(data)) {
        if(value === null || value === undefined) continue;
        clean[key] = String(value);
    }
    return clean;
}

function chunk(items, size) {
    const out = [];
    for(let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

/*
    Which failures mean "this phone is gone" and which mean "this message was
    wrong".

    The distinction is not pedantic. One payload goes to every token in a
    batch, so a malformed message fails every single response - and if
    invalid-argument were treated as a dead token, one bad send would delete
    the entire table. So invalid-argument only counts as a dead token when
    something else in the same batch succeeded; when everything failed with it,
    the message is the suspect and nothing is deleted.

    invalid-registration-token is kept even though FCM now usually reports
    unregistered devices under the other code. It is still in the SDK's error
    map, it is unambiguous, and listing it costs nothing.
*/
const DEAD_TOKEN_CODES = [
    MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    MessagingErrorCode.INVALID_REGISTRATION_TOKEN
];

function findDeadTokens(rows, responses) {
    const dead = [];
    const ambiguous = [];
    let delivered = 0;

    responses.forEach((response, index) => {
        if(response.success) {
            delivered += 1;
            return;
        }

        const code = response.error?.code ?? "";
        if(DEAD_TOKEN_CODES.some((known) => code.endsWith(known))) {
            dead.push(rows[index].id);
        } else if(code.endsWith(MessagingErrorCode.INVALID_ARGUMENT)) {
            ambiguous.push(rows[index].id);
        }
    });

    if(ambiguous.length > 0 && delivered > 0) {
        //Something got through, so the payload is fine and these tokens are not.
        dead.push(...ambiguous);
    } else if(ambiguous.length > 0) {
        console.log(`Push: ${ambiguous.length} invalid-argument failures and no successes — treating the message as the fault, keeping the tokens`);
    }

    return { dead, delivered };
}

/*
    Sends one composed message to one batch of tokens and prunes what died.

    Tokens and responses are index-aligned, which is what lets a failure be
    traced back to the row that caused it.
*/
async function sendBatch(client, rows, kind, name, data) {
    const language = rows[0].language ?? DEFAULT_LANGUAGE;
    const text = composeText(kind, name, language);
    if(!text) {
        console.log(`Push: no copy defined for "${kind}"`);
        return;
    }

    const response = await client.sendEachForMulticast({
        tokens: rows.map((row) => row.token),
        notification: { title: text.title, body: text.body },
        data: stringifyData(data),
        //Both are "deliver now": these are time-critical, a parent reading
        //that the bus has their child ten minutes late is worthless.
        android: { priority: "high" },
        apns: {
            headers: { "apns-priority": "10" },
            payload: { aps: { sound: "default" } }
        }
    });

    const { dead } = findDeadTokens(rows, response.responses);
    if(dead.length > 0) {
        await db.deleteTokensByIds(dead);
    }
}

/*
    Notifies a set of users about one event.

    Grouped by language before sending, because the server composes the text
    and two parents on the same route can want different words for the same
    event. Each language group is then split to respect the multicast cap.
*/
async function notifyUsers(userids, { kind, name, data }) {
    const client = getMessagingClient();
    if(!client) return;

    const unique = [...new Set(userids.filter((id) => Number.isInteger(id)))];
    if(unique.length === 0) return;

    const rows = await db.getTokensForUsers(unique);
    if(rows.length === 0) return;

    const byLanguage = new Map();
    for(const row of rows) {
        const language = row.language ?? DEFAULT_LANGUAGE;
        if(!byLanguage.has(language)) byLanguage.set(language, []);
        byLanguage.get(language).push(row);
    }

    for(const group of byLanguage.values()) {
        for(const batch of chunk(group, MAX_TOKENS_PER_SEND)) {
            await sendBatch(client, batch, kind, name, data);
        }
    }
}

/*
    Notifies the parents with a child on a route - for the events that are
    about the whole run rather than one child.

    The route's name is the title here, since there is no single child to name.
    It arrives on the same rows as the recipients, so this is still one query.

    `only` narrows the send to a subset of those parents. It is what keeps the
    afternoon from arriving twice: a parent who has just been told their child
    was dropped off does not also need to be told the run has finished, so the
    caller passes the parents it has not already notified. Note the difference
    between an absent `only` (everyone) and an empty one (nobody) - the second
    is a real answer, not a missing filter.
*/
async function notifyRouteUsers(routeid, { kind, data, only }) {
    const recipients = await db.getRouteRecipients(routeid);
    if(recipients.length === 0) return;

    const allowed = only === undefined ? null : new Set(only);
    const userids = recipients
        .map((row) => row.userid)
        .filter((userid) => allowed === null || allowed.has(userid));

    if(userids.length === 0) return;

    await notifyUsers(userids, { kind: kind, name: recipients[0].route_name, data: data });
}

/*
    The two functions callers should use.

    Deliberately not awaited at the call sites: the HTTP response and the
    socket broadcast are already correct, and a driver should not wait on
    Google to find out their tap worked. Errors are swallowed here so that not
    awaiting can never raise an unhandled rejection.
*/
function notify(userids, payload) {
    notifyUsers(userids, payload).catch((e) => {
        console.log("Push Error (notify): " + e);
    });
}

function notifyRoute(routeid, payload) {
    notifyRouteUsers(routeid, payload).catch((e) => {
        console.log("Push Error (notifyRoute): " + e);
    });
}

module.exports = {
    notify,
    notifyRoute,
    notifyUsers,
    notifyRouteUsers
}