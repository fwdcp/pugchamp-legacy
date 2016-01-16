/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');

module.exports = function(app, database, io, self, server) {
    var onlineUsers = new Map();

    self.getOnlineUserList = function() {
        return _([...onlineUsers.values()]).filter(user => user.setUp).map(user => _.pick(user.toObject(), 'id', 'alias', 'steamID', 'admin')).sortBy('alias').value();
    };

    self.sendMessage = co.wrap(function* sendMessage(message) {
        if (onlineUsers.has(message.user)) {
            message.user = onlineUsers.get(message.user);
        }
        else {
            message.user = yield database.User.findById(message.user);
        }

        message.user = _.pick(message.user.toObject(), 'id', 'alias', 'steamID', 'admin');

        io.sockets.emit('messageReceived', message);
    });

    self.on('userConnected', co.wrap(function*(userID) {
        if (!onlineUsers.has(userID)) {
            onlineUsers.set(userID, yield database.User.findById(userID));
        }

        let user = onlineUsers.get(userID);

        if (user.setUp) {
            self.sendMessage({
                user: userID,
                action: 'connected'
            });
        }

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    }));

    self.on('userDisconnected', co.wrap(function*(userID) {
        if (!onlineUsers.has(userID)) {
            onlineUsers.set(userID, yield database.User.findById(userID));
        }

        let user = onlineUsers.get(userID);

        if (user.setUp) {
            self.sendMessage({
                user: userID,
                action: 'disconnected'
            });
        }

        onlineUsers.delete(userID);

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    }));

    io.sockets.on('connection', function(socket) {
        socket.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('sendChatMessage', function(message) {
            let userRestrictions = self.getUserRestrictions(socket.decoded_token);

            if (!_.includes(userRestrictions.aspects, 'chat')) {
                let trimmedMessage = _.trim(message);

                if (trimmedMessage.length > 0) {
                    self.sendMessage({
                        user: socket.decoded_token,
                        body: trimmedMessage
                    });
                }
            }
        });
    });
};
