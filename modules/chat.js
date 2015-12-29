/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var lodash = require('lodash');

module.exports = function(app, io, self, server) {
    io.sockets.on('authenticated', function(socket) {
        socket.on('sendChat', function(message) {
            let userRestrictions = self.userRestrictions[newAvailability.userID];

            if (!lodash.includes(userRestrictions.aspects, 'comms')) {
                io.sockets.emit('chatReceived', {
                    user: self.getFilteredUser(userID),
                    message: message
                });
            }
        });
    });
};
