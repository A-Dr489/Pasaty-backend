/*
    Every word a parent reads in a notification.

    Kept apart from the sending machinery in utils/push.js so the wording can be
    corrected without going near the transport, and so all of it can be read at
    once when a new language is added.

    ARABIC AND GENDER
    -----------------
    Arabic verbs agree with the subject's gender, and the database does not
    record a student's gender - so "صعد" (he boarded) would be wrong for half
    the children. Every line below is therefore written in the impersonal
    passive: "تم الصعود" (boarding took place) rather than "صعد". It reads a
    little more formal than speech, and it is correct for every child.

    If a gender column is ever added to students, these can become two variants
    and nothing outside this file has to change.

    The title is the child's first name for anything about one child, and the
    route's name for anything about the whole run. That keeps the brand name
    out of the strings entirely, so nothing here has to be transliterated.
*/

const LANGUAGES = ["en", "ar"];
const DEFAULT_LANGUAGE = "en";

//One entry per notifiable event. `name` is the child's first name, or the
//route's name for the two run-level events.
const TEXT = {
    boarded_morning: {
        en: { body: "Boarded the bus" },
        ar: { body: "تم الصعود إلى الحافلة" }
    },
    absent_morning: {
        en: { body: "Marked absent this morning" },
        ar: { body: "تم تسجيل الغياب هذا الصباح" }
    },
    arrived_school: {
        en: { body: "Arrived at school" },
        ar: { body: "تم الوصول إلى المدرسة" }
    },
    boarded_afternoon: {
        en: { body: "Boarded the bus for the trip home" },
        ar: { body: "تم الصعود إلى الحافلة للعودة" }
    },
    absent_afternoon: {
        en: { body: "Marked absent this afternoon" },
        ar: { body: "تم تسجيل الغياب هذا المساء" }
    },
    dropped_off: {
        en: { body: "Dropped off" },
        ar: { body: "تم الإنزال" }
    },
    run_started_morning: {
        en: { body: "The morning trip has started" },
        ar: { body: "بدأت الرحلة الصباحية" }
    },
    run_started_afternoon: {
        en: { body: "The afternoon trip has started" },
        ar: { body: "بدأت الرحلة المسائية" }
    },
    run_completed_afternoon: {
        en: { body: "The afternoon trip is complete" },
        ar: { body: "انتهت الرحلة المسائية" }
    }
};

/*
    The visible half of a push, in one language.

    An unknown language falls back to English rather than throwing: a device
    row with a locale we have not translated yet should still get a
    notification it can read most of, not silence.
*/
function composeText(kind, name, language) {
    const entry = TEXT[kind];
    if(!entry) return null;

    const copy = entry[language] ?? entry[DEFAULT_LANGUAGE];

    return {
        title: name ?? "",
        body: copy.body
    };
}

module.exports = {
    LANGUAGES,
    DEFAULT_LANGUAGE,
    TEXT,
    composeText
}