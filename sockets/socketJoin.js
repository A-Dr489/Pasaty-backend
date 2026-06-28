export default async function socketJoinRoom(socket, routeid) {
    try{
        //roomid can be extracted by room = `route_${route.id}`
    } catch(e) {
        console.log("Server Error (socketJoinRoom): " + e);
        socket.disconnect();
        return;
    }
}