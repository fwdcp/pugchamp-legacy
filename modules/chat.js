/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');

module.exports = function(app, database, io, self, server) {
    var onlineUsers = new Set();

    self.getOnlineUserList = function() {
        return _([...onlineUsers]).map(userID => self.getCachedUser(userID)).filter(user => user.setUp).sortBy('alias').value();
    };

    self.sendMessage = function sendMessage(message) {
        if (message.user) {
            message.user = self.getCachedUser(message.user);
        }

        io.sockets.emit('messageReceived', message);
    };

    self.on('userConnected', function(userID) {
        onlineUsers.add(userID);

        let user = self.getCachedUser(userID);

        if (user.setUp) {
            self.sendMessage({
                user: userID,
                action: 'connected'
            });
        }

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    self.on('userDisconnected', function(userID) {
        let user = self.getCachedUser(userID);

        if (user.setUp) {
            self.sendMessage({
                user: userID,
                action: 'disconnected'
            });
        }

        onlineUsers.delete(userID);

        io.sockets.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('onlineUserListUpdated', self.getOnlineUserList());
    });

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token.user;

        socket.on('sendChatMessage', function(message) {
            let userRestrictions = self.getUserRestrictions(userID);

            if (!_.includes(userRestrictions.aspects, 'chat')) {
                let trimmedMessage = _.trim(message);

                if (trimmedMessage.length > 0) {
                    self.sendMessage({
                        user: userID,
                        body: trimmedMessage
                    });
                }
				if (trimmedMessage.includes("!admin")) {
					self.sendMessage({
						body: "An admin has been requested. Abuse of this command will result in a ban."
					});
					var user = userID;
					user = self.getCachedUser(user)

					self.emit('adminRequested', user);
				}
				if (trimmedMessage.includes("!mumble")) {
					self.sendMessage({
						body: "216.52.148.10:18460"
					});
				}
            }
        });
    });
};
