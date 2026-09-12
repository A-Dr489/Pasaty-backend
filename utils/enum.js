const ROLE = {
    ADMIN: "admin",
    SUB_ADMIN: "sub-admin",
    SCHOOL: "school",
    PARENT: "parent",
    DRIVER: "driver"
}

/*
    The roles that reach the admin portal. They see the same screens - every
    route that used to read requiredRole(ROLE.ADMIN) reads this list - and
    differ in who they may create and, for ROLE.SCHOOL, in which rows they are
    shown at all.

    Membership here means one thing: only ROLE.ADMIN may create or manage a user
    whose role is in this list. So a sub-admin cannot mint another portal
    account, promote anyone into one, or edit, delete or sign out an existing
    one, and neither can a school account. None of them can widen its own circle
    or lock the real admin out.

    ROLE.SCHOOL adds a second, separate limit that this list says nothing about:
    it only ever sees rows belonging to the one school in school_account. That
    is resolved per request in authMiddleware and applied by schoolScope in
    utils/functions.js - being in this list gets it to an endpoint, it does not
    decide what the endpoint answers.
*/
const PORTAL_ROLES = [ROLE.ADMIN, ROLE.SUB_ADMIN, ROLE.SCHOOL];

const SOCKET_EVENT = {
    JOIN: "route:join",
    LEAVE: "route:leave",
    ATTENDANCE_MORNING_START: "attendance:morning_started",
    ATTENDANCE_UPDATED: "attendance:updated",
    ATTENDANCE_MORNING_COMPLETE: "route:morning_completed",
    ATTENDANCE_AFTERNOON_START: "attendance:afternoon_started",
    ATTENDANCE_AFTERNOON_COMPLETE: "route:afternoon_completed",
    ATTENDANCE_ADMIN_OVERRIDE: "attendance:admin_override",
    DRIVER_LOCATION: "driver:location",   //driver -> server
    BUS_LOCATION: "bus:location",         //server -> route room
    ETA_UPDATED: "eta:updated",           //server -> route room
    ROOM_ERROR: "route:error"             //server -> the socket that asked
}

const PHASE = {
    MORNING: 'morning',
    AFTERNOON: 'afternoon'
}

const ROUTE_STATUS = {
    IN_PROGRESS: 'IN_PROGRESS',
    CANCELLED: 'CANCELLED',
    COMPLETED: 'COMPLETED'
}

const ATTENDANCE_STATUS = {
    WAITING: 'WAITING',
    BOARDED: 'BOARDED',
    ARRIVED: 'ARRIVED',
    ABSENT: 'ABSENT',
    DROPPED_OFF: 'DROPPED_OFF'
}

module.exports = {
    ROLE,
    PORTAL_ROLES,
    SOCKET_EVENT,
    PHASE,
    ROUTE_STATUS,
    ATTENDANCE_STATUS
}