const ROLE = {
    ADMIN: "admin",
    SUB_ADMIN: "sub-admin",
    PARENT: "parent",
    DRIVER: "driver"
}

/*
    The two roles that reach the admin portal. They see exactly the same
    screens - every route that used to read requiredRole(ROLE.ADMIN) now reads
    this list - and differ only in who they may create and manage.

    That difference is one rule, applied wherever a portal account could be
    made or altered: only ROLE.ADMIN may touch a user whose role is in here.
    A sub-admin therefore cannot mint another portal account, promote anyone
    into one, or edit, delete or sign out an existing one, which means it can
    never widen its own circle or lock the real admin out. Everything below
    that line - parents, drivers, routes, schools, attendance - is open to it.

    Kept as a list rather than repeated literals so that adding a third portal
    role later is one edit here, not thirty across the routers.
*/
const PORTAL_ROLES = [ROLE.ADMIN, ROLE.SUB_ADMIN];

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