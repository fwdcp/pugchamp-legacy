/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";
var lodash = require('lodash');

module.exports = function(app, io, self, server) {
    self.on('sendUserChatMessage', function(chat) {
        let userRestrictions = self.userRestrictions[chat.userID];

        if (!lodash.includes(userRestrictions.aspects, 'comms')) {
            let trimmedMessage = (chat.message || '').trim();

            if (trimmedMessage.length > 0) {
                io.sockets.emit('chatMessageReceived', {
                    user: self.getFilteredUser(chat.userID),
                    message: trimmedMessage
                });
            }
        }
    });
	
	self.on('sendPlayerConnectMessage', function(chat) {
		let userRestrictions = self.userRestrictions[chat.userID];

		io.sockets.emit('playerConnectReceived', {
			user: self.getFilteredUser(chat.userID),
			message: chat.message
		});
		

	});

    io.sockets.on('authenticated', function(socket) {

        socket.on('sendChatMessage', function(message) {

            self.emit('sendUserChatMessage', {
                userID: socket.decoded_token,
                message: message

            });
        });
		socket.on('playerConnected', function(message) {
			self.emit('sendPlayerConnectMessage', {
			userID: socket.decoded_token,
			message: message
			
			});
		
		});
    });
};
