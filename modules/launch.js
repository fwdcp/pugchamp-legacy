'use strict';

const _ = require('lodash');
const co = require('co');
const Combinatorics = require('js-combinatorics');
const config = require('config');
const moment = require('moment');
const ms = require('ms');

module.exports = function(app, chance, database, io, self) {
    const AUTO_READY_THRESHOLD = ms(config.get('app.launch.autoReadyThreshold'));
    const GET_LAUNCH_HOLD_DEBOUNCE_MAX_WAIT = 5000;
    const GET_LAUNCH_HOLD_DEBOUNCE_WAIT = 1000;
    const READY_PERIOD = ms(config.get('app.launch.readyPeriod'));
    const ROLES = config.get('app.games.roles');
    const TEAM_SIZE = config.get('app.games.teamSize');

    function calculateRolesNeeded(playersAvailable) {
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

    var lastActivity = new Map();

    var captainsAvailable = new Set();
    var playersAvailable = _.mapValues(ROLES, function() {
        return new Set();
    });
    var launchHolds = [];

    var launchAttemptActive = false;
    var launchAttemptStart = null;
    var readiesReceived = new Set();

    var currentStatusInfo;

    function getLaunchHolds(forceUpdate) {
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

            if (launchAttemptActive) {
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

            if (self.isDraftActive()) {
                launchHolds.push('inactiveDraft');
            }

            let availableServers;

            if (forceUpdate) {
                availableServers = yield self.getAvailableServers();
            }
            else {
                availableServers = yield self.throttledGetAvailableServers();
            }

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
            allPlayersAvailable: _.chain(playersAvailable).reduce(function(allPlayers, players) {
                return _.union(allPlayers, [...players]);
            }, []).map(function(userID) {
                return self.getCachedUser(userID);
            }).value(),
            captainsAvailable: _.map([...captainsAvailable], function(userID) {
                return self.getCachedUser(userID);
            }),
            rolesNeeded: calculateRolesNeeded(playersAvailable),
            teamSize: TEAM_SIZE,
            launchHolds: launchHolds,
            active: launchAttemptActive
        };
    }

    function getCurrentStatusMessage() {
        if (launchAttemptActive) {
            currentStatusInfo.timeElapsed = Date.now() - launchAttemptStart;
            currentStatusInfo.timeTotal = READY_PERIOD;
        }
        else {
            delete currentStatusInfo.timeElapsed;
            delete currentStatusInfo.timeTotal;
        }

        return currentStatusInfo;
    }

    function attemptLaunch() {
        return co(function*() {
            try {
                launchHolds = yield getLaunchHolds(true);

                playersAvailable = _.mapValues(playersAvailable, function(available) {
                    return new Set(_.intersection([...available], [...readiesReceived]));
                });
                captainsAvailable = new Set(_.intersection([...captainsAvailable], [...readiesReceived]));
            }
            catch (err) {
                self.postToLog({
                    description: 'encountered error while updating status',
                    error: err
                });

                self.sendMessage({
                    action: 'failed to update status of launch'
                });

                launchAttemptActive = false;
                launchAttemptStart = null;

                self.updateLaunchStatus();

                return;
            }

            if (_.size(launchHolds) === 0) {
                try {
                    yield self.launchDraft({
                        players: _.mapValues(playersAvailable, function(available) {
                            return [...available];
                        }),
                        captains: [...captainsAvailable]
                    });
                }
                catch (err) {
                    self.postToLog({
                        description: 'encountered error while launching draft',
                        error: err
                    });

                    self.sendMessage({
                        action: 'failed to launch draft due to internal error'
                    });

                    self.cleanUpDraft();
                }
            }
            else {
                self.sendMessage({
                    action: 'failed to launch new draft due to holds'
                });
            }

            launchAttemptActive = false;
            launchAttemptStart = null;

            self.updateLaunchStatus();
        });
    }

    function syncUserAvailability(userID) {
        self.emitToUser(userID, 'userAvailabilityUpdated', [{
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: captainsAvailable.has(userID)
        }]);
    }

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

        syncUserAvailability(userID);

        self.updateLaunchStatus();
    }

    function updateUserReadyStatus(userID, ready) {
        if (launchAttemptActive) {
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

    function autoReadyRecentlyActiveUsers() {
        lastActivity.forEach(function(lastActivity, userID) {
            if (moment().diff(lastActivity) < AUTO_READY_THRESHOLD) {
                updateUserReadyStatus(userID, true);
            }
        });
    }

    function beginLaunchAttempt() {
        return co(function*() {
            if (!launchAttemptActive) {
                try {
                    let timeout = setTimeout(attemptLaunch, READY_PERIOD);

                    if (!timeout) {
                        throw new Error('timeout failed');
                    }

                    launchAttemptActive = true;
                    launchAttemptStart = Date.now();

                    readiesReceived = new Set();

                    io.sockets.emit('userReadyStatusUpdated', false);

                    autoReadyRecentlyActiveUsers();

                    launchHolds = yield getLaunchHolds(false);

                    updateStatusInfo();

                    io.sockets.emit('launchStatusUpdated', getCurrentStatusMessage());
                }
                catch (err) {
                    self.postToLog({
                        description: 'encountered error while beginning launch attempt',
                        error: err
                    });

                    self.sendMessage({
                        action: 'failed to begin launch attempt due to internal error'
                    });

                    launchAttemptActive = false;
                    launchAttemptStart = null;

                    self.updateLaunchStatus();
                }
            }
        });
    }

    const checkLaunchHolds = _.debounce(co.wrap(function* checkLaunchHolds() {
        launchHolds = yield getLaunchHolds(false);

        updateStatusInfo();

        io.sockets.emit('launchStatusUpdated', getCurrentStatusMessage());

        if (!launchAttemptActive && _.size(launchHolds) === 0) {
            yield beginLaunchAttempt();
        }
    }), GET_LAUNCH_HOLD_DEBOUNCE_WAIT, {
        maxWait: GET_LAUNCH_HOLD_DEBOUNCE_MAX_WAIT
    });

    self.markUserActivity = function markUserActivity(userID) {
        lastActivity.set(userID, new Date());
    };

    self.updateLaunchStatus = function updateLaunchStatus() {
        updateStatusInfo();

        io.sockets.emit('launchStatusUpdated', getCurrentStatusMessage());

        checkLaunchHolds();
    };

    self.updateLaunchStatus();

    io.sockets.on('connection', function(socket) {
        socket.emit('launchStatusUpdated', getCurrentStatusMessage());
    });

    function onUserUpdateAvailability(availability) {
        let userID = this.decoded_token.user;

        self.markUserActivity(userID);

        updateUserAvailability(userID, availability);

        if (launchAttemptActive) {
            updateUserReadyStatus(userID, true);
        }
    }

    function onUserUpdateReadyStatus(ready) {
        let userID = this.decoded_token.user;

        self.markUserActivity(userID);

        updateUserReadyStatus(userID, ready);
    }

    io.sockets.on('authenticated', function(socket) {
        let userID = socket.decoded_token.user;

        socket.removeAllListeners('updateAvailability');
        socket.on('updateAvailability', onUserUpdateAvailability);

        socket.removeAllListeners('updateReadyStatus');
        socket.on('updateReadyStatus', onUserUpdateReadyStatus);

        socket.emit('userAvailabilityUpdated', {
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: captainsAvailable.has(userID)
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

        syncUserAvailability(userID);

        self.updateLaunchStatus();
    });

    self.updateLaunchStatus();
};
