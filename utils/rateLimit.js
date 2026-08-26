const { rateLimit } = require("express-rate-limit");

/* ---------------------------------------------------------------------------
   RATE LIMITING

   Only the credential endpoints are limited. Everything else in the API already
   sits behind an access token, a role check and a token-version check, so an
   attacker cannot reach it without an account in the first place - and a
   blanket limiter is exactly what would punish the portal's real traffic, which
   is infinite scroll and search-as-you-type firing many small requests in a
   burst.

   WHY THIS IS INVISIBLE TO REAL USERS

   Every limiter below counts failures only (skipSuccessfulRequests). A
   successful login never adds to any counter, so a person who signs in
   correctly - however often, from wherever - can never be throttled. The budget
   is only spent by requests that were already going to be rejected.

   That also settles the shared-address problem, which matters here: a school's
   staff on one WiFi, or a whole city of parents behind a mobile carrier's NAT,
   arrive as a single IP. What they share is a budget of *failures*, and the
   ceilings below are set well above what a bad afternoon of typos looks like.
--------------------------------------------------------------------------- */

const WINDOW = 15 * 60 * 1000;

//429 in the shape the rest of the API answers in, so the client's existing
//error handling reads it without a special case.
function tooMany(message) {
    return (_req, res) => res.status(429).json({ message: message });
}

const base = {
    windowMs: WINDOW,
    skipSuccessfulRequests: true,
    //RateLimit-* response headers, so a client can see what is left.
    standardHeaders: "draft-8",
    legacyHeaders: false
};

/*
    Login, keyed by the account being attacked rather than by where the attack
    comes from. An attacker rotating through a botnet still spends one shared
    budget per phone number, and a parent on the same WiFi as fifty others is
    unaffected by their neighbours' mistakes.

    WHAT 15 COSTS AND BUYS

    Once the budget is gone the account is refused for the rest of the window
    even if the next password is the right one - the limiter decides before the
    handler ever sees the credentials. So this number is the number of wrong
    guesses a genuine, forgetful user is allowed, and there is no password reset
    in this system: someone who cannot remember has to call an admin. Fifteen
    covers trying every password they own, twice, before that happens.

    What it costs an attacker: 60 guesses an hour against one account. Against
    anything but a password already in the top-100 list that is not a threat -
    and a password that weak is not a problem rate limiting can solve.

    The tradeoff worth knowing: somebody who knows a phone number can spend that
    account's budget on purpose and lock its owner out for the rest of the
    window. That is why this is a rate limit and not a lockout - it heals by
    itself in fifteen minutes, and the alternative of no limit is worse.
*/
const loginByAccount = rateLimit({
    ...base,
    limit: 15,
    //No IP in the key at all - that is the point of this one.
    keyGenerator: (req) => `phone:${String(req.body?.phone ?? "").trim()}`,
    handler: tooMany("Too many failed sign-in attempts for this account. Try again in a few minutes.")
});

/*
    The other half: one host spraying one password across many accounts never
    trips the per-account limit, because each account only sees a single failure.
    This catches it.

    Set high on purpose. This is a backstop, not the main defence - the
    per-account limit above is what actually protects an account - and an
    address here is not a person: a school's staff share one WiFi, and a mobile
    carrier can put a whole city behind a single NAT. Choosing a tight number
    would mean one stranger's typos locking out everyone on their network.

    150 failures inside fifteen minutes from one address is still far past what
    a shared connection produces honestly, while leaving a sprayer no useful
    room. No keyGenerator, so the library's own IPv6-safe default is used.
*/
const loginByAddress = rateLimit({
    ...base,
    limit: 150,
    handler: tooMany("Too many failed sign-in attempts from this network. Try again in a few minutes.")
});

/*
    Refresh runs on a timer, not on a person: every active session calls it each
    time a 15-minute access token expires, and every app resume calls it too. So
    the ceiling is high, and again only failures count.

    A real client fails here once - when the 15-day refresh token finally
    expires - and then goes to the login screen. Sixty leaves room for a whole
    NAT of clients doing that on the same afternoon.
*/
const refresh = rateLimit({
    ...base,
    limit: 60,
    handler: tooMany("Too many token refreshes. Try again in a few minutes.")
});

module.exports = {
    loginByAccount,
    loginByAddress,
    refresh
};