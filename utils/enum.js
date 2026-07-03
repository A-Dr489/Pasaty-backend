export const ROLE = {
    ADMIN: "admin",
    USER: "user",
    PARENT: "parent",
    DRIVER: "driver"
}

export const SOCKET_EVENT = {
    JOIN: "route:join",
    LEAVE: "route:leave",
    ATTENDANCE_MORNING_START: "attendance:morning_started",
    ATTENDANCE_UPDATED: "attendance:updated",
    ATTENDANCE_MORNING_COMPLETE: "route:morning_completed",
    ATTENDANCE_AFTERNOON_START: "attendance:afternoon_started",
    ATTENDANCE_AFTERNOON_COMPLETE: "route:afternoon_completed"
}

export const ROUTE_STATUS = {
    IN_PROGRESS: 'IN_PROGRESS',
    CANCELLED: 'CANCELLED',
    COMPLETED: 'COMPLETED'
}

export const ATTENDANCE_STATUS = {
    WAITING: 'WAITING',
    BOARDED: 'BOARDED',
    ARRIVED: 'ARRIVED',
    ABSENT: 'ABSENT',
    DROPPED_OFF: 'DROPPED_OFF'
}