/*
    Turning progress along a route into arrival times.

    Distances are metres, durations are seconds, and a station is how far along
    the current run something sits - see utils/geo.js. Nothing here reads the
    database or touches a socket, so every number below can be checked on its
    own.
*/

const { PHASE, ATTENDANCE_STATUS } = require("./enum.js");

//How far the bus must travel before its own pace outweighs Mapbox's plan.
const PACE_TRUST_METERS = 300;
//A real run can be far slower or faster than planned, but not beyond this.
const MIN_PACE_FACTOR = 0.25;
const MAX_PACE_FACTOR = 2;
//Never divide by a pace slower than this or an ETA lands next week.
const MIN_PACE_MS = 0.4;
//A stop the bus has only just passed is still arriving, not missed.
const ARRIVAL_TOLERANCE_M = 60;
//Below this share of the planned pace the estimate stops being trustworthy.
const LOW_CONFIDENCE_PACE_FACTOR = 0.35;
//A fix this far off the line means the bus is not on the road we measured.
const LOW_CONFIDENCE_OFFSET_M = 60;
//Ignore the observed pace until a run has had time to mean anything.
const PACE_WARMUP_SECONDS = 60;

/*
    How fast the bus is really covering ground.

    Mapbox's planned pace is the starting point, and the run's own pace is
    blended in as distance accumulates - a bus that has moved twenty metres
    says nothing useful about the next kilometre. Because the observed pace is
    measured from the start of the run it already contains the time spent
    standing at the stops made so far, so dwell needs no separate constant.
*/
function effectivePace(plannedPace, travelled, elapsedSeconds) {
    if(!(plannedPace > 0)) return null;
    if(!(elapsedSeconds > PACE_WARMUP_SECONDS) || !(travelled > 0)) return plannedPace;

    const observed = travelled / elapsedSeconds;
    const trust = Math.min(1, travelled / PACE_TRUST_METERS);
    const blended = trust * observed + (1 - trust) * plannedPace;

    return Math.min(
        Math.max(blended, plannedPace * MIN_PACE_FACTOR, MIN_PACE_MS),
        plannedPace * MAX_PACE_FACTOR
    );
}

/*
    Whether a student is still waiting on the bus in this phase.

    Morning, the wait ends the moment they board - or never starts if they are
    marked absent. Afternoon runs the other way round: boarding at school is
    the beginning of the wait, and it only ends at their own door.
*/
function isAwaiting(stop, phase) {
    if(phase === PHASE.AFTERNOON) {
        return stop.afternoon_status !== ATTENDANCE_STATUS.DROPPED_OFF
            && stop.afternoon_status !== ATTENDANCE_STATUS.ABSENT;
    }

    return stop.morning_status === null
        || stop.morning_status === undefined
        || stop.morning_status === ATTENDANCE_STATUS.WAITING;
}

//Estimates for the stops the bus has yet to reach, nearest first.
function stopEtas(stops, busStation, pace, now) {
    if(!(pace > 0)) return [];

    return stops
        .map((stop) => ({ stop: stop, metersAway: stop.station - busStation }))
        .filter((entry) => entry.metersAway > -ARRIVAL_TOLERANCE_M)
        .sort((a, b) => a.metersAway - b.metersAway)
        .map((entry) => {
            //A stop the bus is level with, or has just passed, arrives now.
            const remaining = Math.max(0, entry.metersAway);
            const seconds = Math.round(remaining / pace);

            return {
                studentid: entry.stop.studentid,
                attendanceid: entry.stop.attendanceid ?? null,
                meters_away: Math.round(remaining),
                seconds_away: seconds,
                eta: new Date(now + seconds * 1000).toISOString()
            };
        });
}

/*
    A run that is crawling compared to plan, or a bus snapping far from the
    line it is supposed to be on, both mean the same thing to a client: show a
    wider window rather than a confident countdown.
*/
function paceConfidence(pace, plannedPace, snapOffset) {
    if(!(pace > 0) || !(plannedPace > 0)) return "low";
    if(pace < plannedPace * LOW_CONFIDENCE_PACE_FACTOR) return "low";
    if(snapOffset !== null && snapOffset > LOW_CONFIDENCE_OFFSET_M) return "low";
    return "normal";
}

/*
    The whole payload for one ping. `stops` must already carry stations in the
    orientation of the current run, so that a bigger station always means
    further ahead of the bus, in both phases.
*/
function buildEstimate({ routeid, phase, busStation, stops, plannedPace, elapsedSeconds, snapOffset, now }) {
    const pace = effectivePace(plannedPace, busStation, elapsedSeconds);
    const awaiting = stops.filter((stop) => isAwaiting(stop, phase));

    return {
        routeid: routeid,
        phase: phase,
        pace: pace === null ? null : Math.round(pace * 100) / 100,
        confidence: paceConfidence(pace, plannedPace, snapOffset),
        generated_at: new Date(now).toISOString(),
        stops: stopEtas(awaiting, busStation, pace, now)
    };
}

module.exports = {
    effectivePace,
    isAwaiting,
    stopEtas,
    paceConfidence,
    buildEstimate
}
