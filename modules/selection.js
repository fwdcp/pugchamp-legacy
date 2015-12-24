var config = require('config');
var lodash = require('lodash');
var mongoose = require('mongoose');

var database = require('../database');

function calculateNeededRoles(playersAvailable) {
    var roles = config.get('app.games.roles');
    var roleNames = lodash.keys(roles);
    var missingCombinations = [];
    var filledRoles = [];

    lodash.forEach(roleNames, function(roleName) {
        var available = playersAvailable[roleName];
        var min = roles[roleName].min * 2;

        if (available.size < min) {
            missingCombinations.push({roles: [roleName], needed: min - available.size});
        }
        else {
            filledRoles.push(roleName);
        }
    });

    var previousFilledCombinations = lodash.map(filledRoles, function(roleName) {
        return [roleName];
    });

    while (lodash.size(previousFilledCombinations) > 0) {
        var newFilledCombinations = [];

        lodash.forEach(previousFilledCombinations, function(previousFilledCombination) {
            var candidateRoles = lodash.drop(filledRoles, lodash.lastIndexOf(filledRoles, lodash.last(previousFilledCombination)) + 1);
            var previousMin = lodash.reduce(previousFilledCombination, function(min, roleName) {
                return min + (roles[roleName].min * 2);
            }, 0);
            var previousAvailable = lodash.reduce(previousFilledCombination, function(available, roleName) {
                return new Set([...available, ...playersAvailable[roleName]]);
            }, new Set());

            lodash.forEach(candidateRoles, function(candidateRole) {
                var available = new Set([...previousAvailable, ...playersAvailable[candidateRole]]);
                var min = previousMin + (roles[candidateRole].min * 2);

                if (available.size < min) {
                    missingCombinations.push({roles: [...previousFilledCombination, candidateRole], needed: min - available.size});
                }
                else {
                    newFilledCombinations.push([...previousFilledCombination, candidateRole]);
                }
            });
        });

        previousFilledCombinations = newFilledCombinations;
    }

    return missingCombinations;
}

module.exports = function(app, io, self, server) {
    var playersAvailable = lodash.mapValues(config.get('app.games.roles'), function() { return new Set(); });
    var captainsAvailable = new Set();
    var neededRoles = calculateNeededRoles(playersAvailable);

    io.sockets.on('connected', function(socket) {
        // send current status of picking
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('changeAvailability', function(availability) {
            if (!lodash.includes(socket.restrictions.aspects, 'play')) {
                lodash.forEach(playersAvailable, function(players, role) {
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

            neededRoles = calculateNeededRoles(playersAvailable);

            // perform checks for PUG ready and send current status to clients
        });
    });

    app.get('/', function(req, res) {
        res.render('index', { user: req.user, roles: config.get('app.games.roles') });
    });
};
