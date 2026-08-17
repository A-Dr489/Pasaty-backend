/*
    Every word a parent reads in a notification.

    Kept apart from the sending machinery in utils/push.js so the wording can be
    corrected without going near the transport, and so all of it can be read at
    once when a new language is added.

    TITLE AND BODY
    --------------
    The title is the app's name in the reader's language, and the body carries
    everything specific — who, and what happened. This is the ordinary shape of
    a phone notification: the heading says which app is speaking, the line under
    it says what about.

    Because the title no longer identifies the child, the child's name has to be
    inside the body, which is what {name} is for.

    ARABIC AND GENDER
    -----------------
    Arabic verbs agree with the subject's gender, and the database does not
    record a student's gender - so "صعد أحمد" (he boarded) would be wrong for
    half the children. Every line below is therefore built on a verbal noun
    instead: "تم صعود أحمد" (the boarding of Ahmad took place). It reads a
    little more formal than speech, and it is correct for every child.

    If a gender column is ever added to students, these can become two variants
    and nothing outside this file has to change.
*/

const LANGUAGES = ["en", "ar"];
const DEFAULT_LANGUAGE = "en";

//The title of every notification, in each language.
const BRAND = {
    en: "Masar Alburhan",
    ar: "مسار البرهان"
};

/*
    One entry per notifiable event.

    {name} is the child's first name. The two run-level events have no {name}:
    they are about the whole bus rather than one child, and naming one of a
    parent's children in a message that concerns all of them would be wrong.
*/
const TEXT = {
    boarded_morning: {
        en: { body: "{name} boarded the bus" },
        ar: { body: "تم صعود {name} إلى الحافلة" }
    },
    absent_morning: {
        en: { body: "{name} was marked absent this morning" },
        ar: { body: "تم تسجيل غياب {name} هذا الصباح" }
    },
    arrived_school: {
        en: { body: "{name} arrived at school" },
        ar: { body: "تم وصول {name} إلى المدرسة" }
    },
    boarded_afternoon: {
        en: { body: "{name} boarded the bus for the trip home" },
        ar: { body: "تم صعود {name} إلى الحافلة للعودة" }
    },
    absent_afternoon: {
        en: { body: "{name} was marked absent this afternoon" },
        ar: { body: "تم تسجيل غياب {name} هذا المساء" }
    },
    dropped_off: {
        en: { body: "{name} was dropped off" },
        ar: { body: "تم إنزال {name}" }
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

    The language is resolved once, up front, so the title and the body can never
    disagree — an untranslated event must not arrive with an Arabic heading over
    an English sentence.

    An unknown language falls back to English rather than throwing: a device row
    with a locale we have not translated yet should still get a notification it
    can read most of, not silence.

    replaceAll rather than replace, so a line that one day mentions the child
    twice substitutes both rather than half of them.
*/
function composeText(kind, name, language) {
    const entry = TEXT[kind];
    if(!entry) return null;

    const lang = entry[language] ? language : DEFAULT_LANGUAGE;

    return {
        title: BRAND[lang] ?? BRAND[DEFAULT_LANGUAGE],
        body: entry[lang].body.replaceAll("{name}", name ?? "").trim()
    };
}

module.exports = {
    LANGUAGES,
    DEFAULT_LANGUAGE,
    BRAND,
    TEXT,
    composeText
}
