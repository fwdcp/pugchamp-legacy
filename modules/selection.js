var Combinatorics = require('js-combinatorics');
var config = require('config');
var lodash = require('lodash');
var mongoose = require('mongoose');

var database = require('../database');

function calculateNeededRoles(playersAvailable) {
    var roles = config.get('app.games.roles');
    var roleNames = lodash.keys(roles);

    var neededCombinations = [];

    var n = lodash.size(roles);

    for (var k = 1; k <= n; k++) {
        var combinations = Combinatorics.combination(roleNames, k).toArray();

        lodash.each(combinations, function(combination) {
            var combinationInfo = lodash.reduce(combination, function(current, roleName) {
                return {
                    available: new Set([...current.available, ...playersAvailable[roleName]]),
                    required: current.required + (roles[roleName].min * 2)
                };
            }, {
                available: new Set(),
                required: 0
            });

            var missing = combinationInfo.required - combinationInfo.available.size;

            if (missing > 0) {
                neededCombinations.push({
                    roles: combination,
                    needed: missing
                });
            }
        });
    }

    return neededCombinations;
}

module.exports = function(app, io, self, server) {
    var playersAvailable = lodash.mapValues(config.get('app.games.roles'), function() { return new Set(); });
    var captainsAvailable = new Set();
    var readiesReceived = [];
    var neededRoles = calculateNeededRoles(playersAvailable);

    var prepareStatusMessage = function() {
        var currentPlayersAvailable = lodash.mapValues(playersAvailable, function(available, roleName) {
            return lodash.map([...available], function(userID) {
                return lodash.omit(io.sockets.connected[self.userSockets[userID].values().next().value].user.toObject(), ['_id', 'id', '__v']);
            });
        });
        var currentCaptainsAvailable = lodash.map([...captainsAvailable], function(userID) {
            return lodash.omit(io.sockets.connected[self.userSockets[userID].values().next().value].user.toObject(), ['_id', 'id', '__v']);
        });
        var currentNeededRoles = lodash.map(neededRoles, function(neededRole) {
            return neededRole;
        });

        return {
            playersAvailable: currentPlayersAvailable,
            captainsAvailable: currentCaptainsAvailable,
            neededRoles: currentNeededRoles
        };
    };

    var currentStatusMessage = prepareStatusMessage();

    io.sockets.on('connection', function(socket) {
        socket.emit('statusUpdated', currentStatusMessage);
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('changeAvailability', function(availability) {
            if (!lodash.includes(socket.restrictions.aspects, 'play')) {
                lodash.forEach(playersAvailable, function(players, role) {
                    if (lodash.includes(availability.roles, role)) {
                        players.add(socket.user.id);
                    }
                    else {
                        players.delete(socket.user.id);
                    }
                });

                if (!lodash.includes(socket.restrictions.aspects, 'captain')) {
                    if (availability.captain) {
                        captainsAvailable.add(socket.user.id);
                    }
                    else {
                        captainsAvailable.delete(socket.user.id);
                    }
                }
            }

            neededRoles = calculateNeededRoles(playersAvailable);
            currentStatusMessage = prepareStatusMessage();
            io.sockets.emit('statusUpdated', currentStatusMessage);

            if (lodash.size(neededRoles) === 0 && captainsAvailable.size >= 2) {
                readiesReceived.clear();
                io.sockets.emit('readiesRequested');

                setTimeout(function() {
                    var finalReadiesReceived = [...readiesReceived];
                    readiesReceived.clear();

                    var finalPlayersAvailable = lodash.mapValues(playersAvailable, function(available, roleName) {
                        return new Set(lodash.intersection([...available], finalReadiesReceived));
                    });
                    var finalCaptainsAvailable = new Set(lodash.intersection([...captainsAvailable], finalReadiesReceived));
                    var finalNeededRoles = calculateNeededRoles(finalPlayersAvailable);

                    playersAvailable = finalPlayersAvailable;
                    captainsAvailable = finalCaptainsAvailable;
                    neededRoles = finalNeededRoles;
                    currentStatusMessage = prepareStatusMessage();
                    io.sockets.emit('statusUpdated', currentStatusMessage);

                    if (lodash.size(finalNeededRoles) === 0 && finalCaptainsAvailable.size >= 2) {
                        self.emit('launchPicking', {
                            players: finalPlayersAvailable,
                            captains: finalCaptainsAvailable
                        });
                    }
                    else {
                        io.sockets.emit('launchAborted');
                    }
                }, 60000);
            }
        });

        socket.on('ready', function() {
            readiesReceived.add(socket.user.id);
        });
        socket.on('unready', function() {
            readiesReceived.delete(socket.user.id);
        });

        socket.on('disconnect', function() {
            if (self.userSockets[socket.user.id].size === 0) {
                lodash.forEach(playersAvailable, function(players, role) {
                    players.delete(socket.user.id);
                });

                captainsAvailable.delete(socket.user.id);

                neededRoles = calculateNeededRoles(playersAvailable);
                currentStatusMessage = prepareStatusMessage();
                io.sockets.emit('statusUpdated', currentStatusMessage);
            }
        });
    });

    app.get('/', function(req, res) {
        res.render('index', { user: req.user, roles: config.get('app.games.roles') });
    });
};
