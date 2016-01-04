/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var lodash = require('lodash');

module.exports = function(app, io, self, server) {
    self.on('sendUserChatMessage', function(chat) {
        let userRestrictions = self.userRestrictions[chat.userID];

        if (!lodash.includes(userRestrictions.aspects, 'comms')) {
            let trimmedMessage = (chat.message || '').trim();

            if (trimmedMessage.length > 0) {
                io.sockets.emit('messageReceived', {
                    user: self.getFilteredUser(chat.userID),
                    body: trimmedMessage
                });
            }
        }
    });

    self.on('sendSystemMessage', function(message) {
        if (message.user) {
            message.user = self.getFilteredUser(message.user);
        }

        io.sockets.emit('messageReceived', message);
    });

    self.on('userConnected', function(userID) {
        self.emit('sendSystemMessage', {
            user: userID,
            action: 'connected'
        });
    });

    self.on('userDisconnected', function(userID) {
        self.emit('sendSystemMessage', {
            user: userID,
            action: 'disconnected'
        });
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
