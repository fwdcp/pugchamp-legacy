/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var lodash = require('lodash');

module.exports = function(app, database, io, self, server) {
    function getOnlineList() {
        return lodash(self.getOnlineList()).filter(function(user) {
            return self.users.get(user).setUp;
        }).map(function(user) {
            return self.users.get(user).toObject();
        }).value();
    }

    function transmitOnlineList() {
        io.sockets.emit('onlineListUpdated', getOnlineList());
    }

    self.on('sendUserChatMessage', function(chat) {
        let userRestrictions = self.userRestrictions.get(chat.userID);

        if (!lodash.includes(userRestrictions.aspects, 'chat')) {
            let trimmedMessage = (chat.message || '').trim();

            if (trimmedMessage.length > 0) {
                io.sockets.emit('messageReceived', {
                    user: self.users.get(chat.userID).toObject(),
                    body: trimmedMessage
                });
            }
        }
    });

    self.on('sendSystemMessage', function(message) {
        if (message.user) {
            message.user = self.users.get(message.user).toObject();
        }

        io.sockets.emit('messageReceived', message);
    });

    self.on('userConnected', function(userID) {
        if (self.users.get(userID).setUp) {
            self.emit('sendSystemMessage', {
                user: userID,
                action: 'connected'
            });

            transmitOnlineList();
        }
    });

    self.on('userDisconnected', function(userID) {
        if (self.users.get(userID).setUp) {
            self.emit('sendSystemMessage', {
                user: userID,
                action: 'disconnected'
            });

            transmitOnlineList();
        }
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('onlineListUpdated', getOnlineList());
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('sendChatMessage', function(message) {
            self.emit('sendUserChatMessage', {
                userID: socket.decoded_token,
                message: message
            });
        });
    });
};
