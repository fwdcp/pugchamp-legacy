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
