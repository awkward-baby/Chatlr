process.on('uncaughtException', function (err) {
  console.log('Caught exception: ' + err);
});

var http = require('http'),
    url  = require('url'),
    fs   = require('fs'),
    io   = require('./socket.io'),
    sys  = require('sys'),
    net  = require('net');

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

var ops    = {'kevinnuut': '', 'lacey': '', 'gompr': '', 'topherchris': ''},
    creds  = {},
    buffer = [],
    rooms  = {},
    users  = {},
    last   = {},
    topic  = 'Anything you want!',

    // Create server to listen on port 8080 for IO
    server = http.createServer(),

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // Create unix socket to talk to PHP server
    unix   = net.createServer(function(stream) {
        try {
            // stream.setEncoding('utf8');
            stream.on('data', function(data) {
                var cred = JSON.parse(data);
                if (typeof cred == 'object' && 'key' in cred) {
                    console.log('Credentials for ' + cred.user.name + ' received.');
                    creds[cred.key] = cred.user;
                }
            });
        } catch(err) {
            console.log(err);
        }
    });

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

// Server listens on port 8080 and connect socket for PHP server talk
server.listen(8080);
unix.listen('unix.socket');

// Create IO socket
var socket = io.listen(server, {transports: ['websocket']});

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

// EVENT: user has connected, initialize them and ask for credentials
socket.on('connection', function(client)
{
    // Send the client their init message
    // along with last 15 messages and user list
    client.send({
        type:   'init',
        id:     client.sessionId,
        topic:  topic,
        buffer: buffer,
        users:  users});

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // EVENT: user has sent a message with either credentials or a message
    client.on('message', function(clientRes)
    {
        // Server can receive either credentials or a message to share
        if ('type' in clientRes && typeof clientRes.type == 'string' && clientRes.type in {'message': '', 'credentials': ''}) {

            // CREDENTIALS: passed from client with authkey to pull from PHP unix socket CREDS
            if (clientRes.type == 'credentials' && 'token' in clientRes && typeof clientRes.token == 'string' && clientRes.token in creds) {
                try {
                    // Check if user is already in chat to prevent duplicates
                    for (var i in users) {
                        if (users[i].name == creds[clientRes.token].name) {
                            console.log('User already in chat!');
                            delete creds[clientRes.token];
                            client.connection.end();
                        }
                    }
                    
                    // Transfer creds to user list and delete from php server creds
                    var currentUser = users[client.sessionId] = creds[clientRes.token];
                    delete creds[clientRes.token];

                    // Setup user as OPERATOR if in the approval list above
                    currentUser.op = (currentUser.name in ops);
                    
                    // Initialize last message for griefing
                    last[client.sessionId] = {
                        timestamp: 0,
                        message: ''};

                    // Broadcast to everyone that this user has connected
                    // This will also add the user to their user list
                    socket.broadcast({
                        type: 'status',
                        mode: 'connect',
                        id:   client.sessionId,
                        user: currentUser});
                } catch(err) {
                    client.disconnect.end();
                    console.log(err);
                }
                
            // MESSAGE: user is sending a message to everyone
            } else if ('message' in clientRes && typeof clientRes.message == 'string') {
                try {
                    var timestamp = new Date().getTime();
                    var message   = clientRes.message.substr(0, 350);

                    if (users[client.sessionId].op) {;
                        if (message.search(/^\/topic/) == 0) {
                            topic = message.substr(7);
                            socket.broadcast({
                                type:  'topic',
                                topic: topic});

                        } else if (message.search(/^\/kick/) == 0) {
                            var name = message.substr(6);
                            for (var i in users) {
                                if (users[i].name == name) {
                                    socket.clients[i].connection.end();

                                    // Remove user and last grief from server
                                    delete users[i];
                                    delete last[i];

                                    // Broadcast to everyone that this user has disconnected
                                    // This will remove user from their list
                                    socket.broadcast({
                                        type:    'status',
                                        mode:    'disconnect',
                                        id:      i,
                                        message: 'left the chat...'});

                                }
                            }
                        }
                    // If there is a message and it isn't the same as their last (griefing)
                    } else if (message.length > 0 && client.sessionId in last &&
                        message != last[client.sessionId].message &&
                        timestamp - last[client.sessionId].timestamp > 3000) {

                        if (message.search(/^\/topic/) == 0) {
                            socket.broadcast({
                                type:    'status',
                                mode:    'away',
                                id:      client.sessionId});

                        }

                        // Store last message to track griefing
                        last[client.sessionId] = {
                            timestamp: timestamp,
                            message:   message};

                        // Push messages into buffer for user logins
                        buffer.push({
                            type:    'message',
                            user:    users[client.sessionId],
                            message: message});

                        if (buffer.length > 15) {
                            buffer.shift();
                        }

                        // Broadcast message to everyone
                        socket.broadcast({
                            type:    'message',
                            id:      client.sessionId,
                            message: message});
                    }
                } catch(err) {
                    console.log(err);
                }

            } else {
                // Invalid message type sent, disconnect user
                console.log('invalid message');
                console.log(clientRes);
                client.connection.end();
            }
            
        } else {
            // Invalid properties sent, disconnect user
            console.log('invalid type');
            console.log(clientRes);
            client.connection.end();
        }
    });

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // EVENT: Disconnect
    client.on('disconnect', function()
    {
        // Remove user and last grief from server
        delete users[client.sessionId];
        delete last[client.sessionId];

        // Broadcast to everyone that this user has disconnected
        // This will remove user from their list
        client.broadcast({
            type:    'status',
            mode:    'disconnect',
            id:      client.sessionId,
            message: 'left the chat...'});
    });
});
