/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const Combinatorics = require('js-combinatorics');
const config = require('config');
const ms = require('ms');

module.exports = function(app, database, io, self, server) {
    const READY_PERIOD = ms(config.get('app.launch.readyPeriod'));
    const ROLES = config.get('app.games.roles');
    const TEAM_SIZE = config.get('app.games.teamSize');

    function calculateRolesNeeded(playersAvailable) {
        let roles = config.get('app.games.roles');
        let roleNames = _.keys(ROLES);

        let neededCombinations = [];

        let n = _.size(ROLES);

        function checkCombination(combination) {
            let combinationInfo = _.reduce(combination, function(current, roleName) {
                return {
                    available: new Set([...current.available, ...playersAvailable[roleName]]),
                    required: current.required + (ROLES[roleName].min * 2)
                };
            }, {
                available: new Set(),
                required: 0
            });

            let missing = combinationInfo.required - combinationInfo.available.size;

            if (missing > 0) {
                neededCombinations.push({
                    roles: combination,
                    needed: missing
                });
            }
        }

        for (let k = 1; k <= n; k++) {
            let combinations = Combinatorics.combination(roleNames, k).toArray();

            _.forEach(combinations, checkCombination);
        }

        return neededCombinations;
    }

    var captainsAvailable = new Set();
    var playersAvailable = _.mapValues(ROLES, function() {
        return new Set();
    });
    var launchHolds = [];

    var launchAttemptInProgress = false;
    var launchAttemptStart = null;
    var readiesReceived = new Set();

    var currentStatusInfo;

    function getLaunchHolds() {
        return co(function*() {
            let launchHolds = [];

            if (captainsAvailable.size < 2) {
                launchHolds.push('availableCaptains');
            }

            let allPlayersAvailable = _.reduce(playersAvailable, function(allPlayers, players) {
                return new Set(_.union([...allPlayers], [...players]));
            }, new Set());

            if (allPlayersAvailable.size < 2 * TEAM_SIZE) {
                launchHolds.push('availablePlayers');
            }

            let availablePlayerRolesNeeded = calculateRolesNeeded(playersAvailable);

            if (_.size(availablePlayerRolesNeeded) !== 0) {
                launchHolds.push('availablePlayerRoles');
            }

            if (launchAttemptInProgress) {
                let captainsReady = new Set(_.intersection([...captainsAvailable], [...readiesReceived]));

                if (captainsReady.size < 2) {
                    launchHolds.push('readyCaptains');
                }

                let allPlayersReady = new Set(_.intersection([...allPlayersAvailable], [...readiesReceived]));

                if (allPlayersReady.size < 2 * TEAM_SIZE) {
                    launchHolds.push('readyPlayers');
                }

                let playersReady = _.mapValues(playersAvailable, function(available) {
                    return new Set(_.intersection([...available], [...readiesReceived]));
                });

                let readyPlayerRolesNeeded = calculateRolesNeeded(playersReady);

                if (_.size(readyPlayerRolesNeeded) !== 0) {
                    launchHolds.push('readyPlayerRoles');
                }
            }

            // TODO: check draft status

            let availableServers = yield self.getAvailableServers();

            if (_.size(availableServers) === 0) {
                launchHolds.push('availableServers');
            }

            return launchHolds;
        });
    }

    function updateStatusInfo() {
        currentStatusInfo = {
            roles: ROLES,
            playersAvailable: _.mapValues(playersAvailable, function(available) {
                return _.map([...available], function(userID) {
                    return self.getCachedUser(userID);
                });
            }),
            captainsAvailable: _.map([...captainsAvailable], function(userID) {
                return self.getCachedUser(userID);
            }),
            rolesNeeded: calculateRolesNeeded(playersAvailable),
            launchHolds: launchHolds
        };
    }

    function getCurrentStatusMessage() {
        let statusMessage;

        if (launchAttemptInProgress) {
            statusMessage = {
                active: true,
                timeElapsed: Date.now() - launchAttemptStart,
                timeTotal: READY_PERIOD
            };
        }
        else {
            statusMessage = {
                active: false
            };
        }

        _.assign(statusMessage, currentStatusInfo);

        return statusMessage;
    }

    function attemptLaunch() {
        return co(function*() {
            launchHolds = yield getLaunchHolds();

            if (_.size(launchHolds) === 0) {
                // TODO: launch draft
                console.log('YAY DRAFT STARTS NOW');
            }

            launchAttemptInProgress = false;
            launchAttemptStart = null;

            playersAvailable = _.mapValues(playersAvailable, function(available) {
                return new Set(_.intersection([...available], [...readiesReceived]));
            });
            captainsAvailable = new Set(_.intersection([...captainsAvailable], [...readiesReceived]));

            yield self.updateLaunchStatus();
        });
    }

    function beginLaunchAttempt() {
        co(function*() {
            if (!launchAttemptInProgress) {
                launchAttemptInProgress = true;
                launchAttemptStart = Date.now();

                readiesReceived = new Set();

                launchHolds = yield getLaunchHolds();

                updateStatusInfo();

                io.sockets.emit('launchStatusUpdated', getCurrentStatusMessage());

                _.delay(attemptLaunch, READY_PERIOD);
            }
        });
    }

    self.updateLaunchStatus = co.wrap(function* updateLaunchStatus() {
        launchHolds = yield getLaunchHolds();

        updateStatusInfo();

        io.sockets.emit('launchStatusUpdated', getCurrentStatusMessage());

        if (!launchAttemptInProgress && _.size(launchHolds) === 0) {
            beginLaunchAttempt();
        }
    });

    self.updateLaunchStatus();

    function updateUserAvailability(userID, availability) {
        let userRestrictions = self.getUserRestrictions(userID);

        if (!_.includes(userRestrictions.aspects, 'start')) {
            _.forEach(playersAvailable, function(players, role) {
                if (_.includes(availability.roles, role)) {
                    players.add(userID);
                }
                else {
                    players.delete(userID);
                }
            });
        }

        if (!_.includes(userRestrictions.aspects, 'captain')) {
            if (availability.captain) {
                captainsAvailable.add(userID);
            }
            else {
                captainsAvailable.delete(userID);
            }
        }

        self.emitToUser(userID, 'userAvailabilityUpdated', [{
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: captainsAvailable.has(userID)
        }]);

        self.updateLaunchStatus();
    }

    function updateUserReadyStatus(userID, ready) {
        if (launchAttemptInProgress) {
            if (ready) {
                readiesReceived.add(userID);
            }
            else {
                readiesReceived.delete(userID);
            }

            self.emitToUser(userID, 'userReadyStatusUpdated', [ready]);
        }

        self.updateLaunchStatus();
    }

    io.sockets.on('connection', function(socket) {
        socket.emit('launchStatusUpdated', getCurrentStatusMessage());
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('updateAvailability', function(availability) {
            updateUserAvailability(socket.decoded_token, availability);
        });

        socket.on('updateReadyStatus', function(ready) {
            updateUserReadyStatus(socket.decoded_token, ready);
        });

        socket.emit('userAvailabilityUpdated', {
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(socket.decoded_token);
            }),
            captain: captainsAvailable.has(socket.decoded_token)
        });
    });

    self.on('userDisconnected', function(userID) {
        updateUserAvailability(userID, {
            roles: [],
            captain: false
        });

        updateUserReadyStatus(userID, false);
    });

    self.on('userRestrictionsUpdated', function(userID) {
        let userRestrictions = self.getUserRestrictions(userID);

        if (_.includes(userRestrictions.aspects, 'start')) {
            _.forEach(playersAvailable, function(players) {
                players.delete(userID);
            });
        }

        if (_.includes(userRestrictions.aspects, 'captain')) {
            captainsAvailable.delete(userID);
        }
    });
};
