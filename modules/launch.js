/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var Combinatorics = require('js-combinatorics');
var config = require('config');
var lodash = require('lodash');
var ms = require('ms');

module.exports = function(app, database, io, self, server) {
    function calculateRolesNeeded(playersAvailable) {
        let roles = config.get('app.games.roles');
        let roleNames = lodash.keys(roles);

        let neededCombinations = [];

        let n = lodash.size(roles);

        function checkCombination(combination) {
            let combinationInfo = lodash.reduce(combination, function(current, roleName) {
                return {
                    available: new Set([...current.available, ...playersAvailable[roleName]]),
                    required: current.required + (roles[roleName].min * 2)
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

            lodash.forEach(combinations, checkCombination);
        }

        return neededCombinations;
    }

    var captainsAvailable = new Set();
    var playersAvailable = lodash.mapValues(config.get('app.games.roles'), function() {
        return new Set();
    });
    var missingLaunchConditions;

    var launchAttemptInProgress = false;
    var launchTime = null;
    var readiesReceived = new Set();

    var currentStatusMessage;

    function checkLaunchConditions() {
        return Promise.all([
            new Promise(function(resolve, reject) {
                if (captainsAvailable.size < 2) {
                    resolve(['notAvailable']);
                    return;
                }

                let allPlayersAvailable = lodash.reduce(playersAvailable, function(allPlayers, players) {
                    return new Set(lodash.union([...allPlayers], [...players]));
                }, new Set());

                if (allPlayersAvailable.size < 2 * config.get('app.games.teamSize')) {
                    resolve(['notAvailable']);
                    return;
                }

                let rolesNeeded = calculateRolesNeeded(playersAvailable);

                if (lodash.size(rolesNeeded) !== 0) {
                    resolve(['notAvailable']);
                    return;
                }

                if (!launchAttemptInProgress) {
                    resolve(['readyNotChecked']);
                    return;
                }

                let finalCaptainsAvailable = new Set(lodash.intersection([...captainsAvailable], [...readiesReceived]));

                if (finalCaptainsAvailable.size < 2) {
                    resolve(['notReady']);
                    return;
                }

                let finalAllPlayersAvailable = new Set(lodash.intersection([...allPlayersAvailable], [...readiesReceived]));

                if (finalAllPlayersAvailable.size < 2 * config.get('app.games.teamSize')) {
                    resolve(['notReady']);
                    return;
                }

                let finalPlayersAvailable = lodash.mapValues(playersAvailable, function(available) {
                    return new Set(lodash.intersection([...available], [...readiesReceived]));
                });

                let finalRolesNeeded = calculateRolesNeeded(finalPlayersAvailable);

                if (lodash.size(finalRolesNeeded) !== 0) {
                    resolve(['notReady']);
                    return;
                }

                resolve([]);
            }),
            new Promise(function(resolve, reject) {
                let received = self.emit('checkIfDraftInProgress', function(inProgress) {
                    if (inProgress) {
                        resolve(['draftCurrentlyRunning']);
                    }
                    else {
                        resolve([]);
                    }
                });

                // NOTE: this resolves a case during startup when the event isn't set up yet
                if (!received) {
                    resolve([]);
                }
            }),
            new Promise(function(resolve, reject) {
                let received = self.emit('getAvailableServers', function(servers) {
                    if (lodash.size(servers) === 0) {
                        resolve(['noAvailableServers']);
                    }
                    else {
                        resolve([]);
                    }
                });

                // NOTE: this resolves a case during startup when the event isn't set up yet
                if (!received) {
                    resolve([]);
                }
            })
        ]).then(function(launchConditions) {
            missingLaunchConditions = lodash(launchConditions).flatten().compact().value();

            return missingLaunchConditions;
        });
    }

    function prepareStatusMessage() {
        currentStatusMessage = {
            roles: config.get('app.games.roles'),
            playersAvailable: lodash.mapValues(playersAvailable, function(available) {
                return lodash.map([...available], function(userID) {
                    return self.users.get(userID).toObject();
                });
            }),
            captainsAvailable: lodash.map([...captainsAvailable], function(userID) {
                return self.users.get(userID).toObject();
            }),
            rolesNeeded: calculateRolesNeeded(playersAvailable),
            missingLaunchConditions: missingLaunchConditions
        };

        return currentStatusMessage;
    }

    function attemptLaunch() {
        if (launchAttemptInProgress) {
            prepareStatusMessage();
            io.sockets.emit('launchStatusUpdated', currentStatusMessage);

            return;
        }

        checkLaunchConditions().then(function() {
            prepareStatusMessage();
            io.sockets.emit('launchStatusUpdated', currentStatusMessage);

            if (lodash(missingLaunchConditions).without('readyNotChecked').size() === 0) {
                launchAttemptInProgress = true;
                launchTime = Date.now();

                readiesReceived = new Set();
                io.sockets.emit('launchInProgress', {
                    elapsed: Date.now() - launchTime,
                    total: ms(config.get('app.launch.readyPeriod'))
                });

                setTimeout(function() {
                    checkLaunchConditions().then(function() {
                        playersAvailable = lodash.mapValues(playersAvailable, function(available) {
                            return new Set(lodash.intersection([...available], [...readiesReceived]));
                        });
                        captainsAvailable = new Set(lodash.intersection([...captainsAvailable], [...readiesReceived]));

                        prepareStatusMessage();
                        io.sockets.emit('launchStatusUpdated', currentStatusMessage);

                        launchAttemptInProgress = false;
                        launchTime = null;

                        if (lodash.size(missingLaunchConditions) === 0) {
                            self.emit('launchGameDraft', {
                                players: lodash.mapValues(playersAvailable, function(available) {
                                    return [...available];
                                }),
                                captains: [...captainsAvailable]
                            });
                        }
                        else {
                            io.sockets.emit('launchAborted');
                        }
                    });
                }, ms(config.get('app.launch.readyPeriod')));
            }
        });
    }

    attemptLaunch();

    self.on('updateUserAvailability', function(newAvailability) {
        let userRestrictions = self.userRestrictions.get(newAvailability.userID);

        if (!lodash.includes(userRestrictions.aspects, 'start')) {
            lodash.forEach(playersAvailable, function(players, role) {
                if (lodash.includes(newAvailability.roles, role)) {
                    players.add(newAvailability.userID);
                }
                else {
                    players.delete(newAvailability.userID);
                }
            });

            if (!lodash.includes(userRestrictions.aspects, 'captain')) {
                if (newAvailability.captain) {
                    captainsAvailable.add(newAvailability.userID);
                }
                else {
                    captainsAvailable.delete(newAvailability.userID);
                }
            }
            else {
                captainsAvailable.delete(newAvailability.userID);
            }
        }
        else {
            lodash.forEach(playersAvailable, function(players) {
                players.delete(newAvailability.userID);
            });

            captainsAvailable.delete(newAvailability.userID);
        }

        self.emit('sendMessageToUser', {
            userID: newAvailability.userID,
            name: 'userAvailabilityUpdated',
            arguments: [{
                roles: lodash.mapValues(playersAvailable, function(players) {
                    return players.has(newAvailability.userID);
                }),
                captain: captainsAvailable.has(newAvailability.userID)
            }]
        });

        attemptLaunch();
    });
    self.on('updateUserReadyStatus', function(readyInfo) {
        if (launchAttemptInProgress) {
            if (readyInfo.ready) {
                readiesReceived.add(readyInfo.userID);
            }
            else {
                readiesReceived.delete(readyInfo.userID);
            }
        }

        self.emit('sendMessageToUser', {
            userID: readyInfo.userID,
            name: 'userReadyStatusUpdated',
            arguments: [readyInfo.ready]
        });
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('launchStatusUpdated', currentStatusMessage);
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('updateAvailability', function(availability) {
            self.emit('updateUserAvailability', {
                userID: socket.decoded_token,
                roles: availability.roles,
                captain: availability.captain
            });
        });

        socket.on('updateReadyStatus', function(ready) {
            self.emit('updateUserReadyStatus', {
                userID: socket.decoded_token,
                ready: ready
            });
        });

        socket.emit('userAvailabilityUpdated', {
            roles: lodash.mapValues(playersAvailable, function(players) {
                return players.has(socket.decoded_token);
            }),
            captain: captainsAvailable.has(socket.decoded_token)
        });

        if (launchAttemptInProgress) {
            socket.emit('launchInProgress', {
                elapsed: Date.now() - launchTime,
                total: ms(config.get('app.launch.readyPeriod'))
            });

            socket.emit('userReadyStatusUpdated', readiesReceived.has(socket.decoded_token));
        }
    });

    self.on('userDisconnected', function(userID) {
        self.emit('updateUserAvailability', {
            userID: userID,
            roles: [],
            captain: false
        });

        self.emit('updateUserReadyStatus', {
            userID: userID,
            ready: false
        });
    });

    self.on('userRestrictionsUpdated', function(userID) {
        self.emit('updateUserAvailability', {
            userID: userID,
            roles: lodash.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: captainsAvailable.has(userID)
        });

        if (launchAttemptInProgress) {
            self.emit('updateUserReadyStatus', {
                userID: userID,
                ready: readiesReceived.has(userID)
            });
        }
    });
};
