var config = require('config');
var lodash = require('lodash');
var mongoose = require('mongoose');

var database = require('../database');

module.exports = function(app, io, self, server) {
    var playersAvailable = lodash.mapValues(config.get('app.games.roles'), function() { return new Set(); });
    var captainsAvailable = new Set();

    io.sockets.on('authenticated', function(socket) {
        socket.on('changeAvailability', function(availability) {
            if (!lodash.includes(socket.restrictions.aspects, 'play')) {
                lodash.each(playersAvailable, function(players, role) {
                    if (lodash.includes(availability.roles, role)) {
                        players.add(socket.id);
                    }
                    else {
                        players.delete(socket.id);
                    }
                });

                if (!lodash.includes(socket.restrictions.aspects, 'captain')) {
                    if (availability.captain) {
                        captainsAvailable.add(socket.id);
                    }
                    else {
                        captainsAvailable.delete(socket.id);
                    }
                }
            }

            // perform checks for PUG ready and send current status to clients
        });
    });

    app.get('/', function(req, res) {
        res.render('index', { user: req.user, roles: config.get('app.games.roles') });
    });
};
