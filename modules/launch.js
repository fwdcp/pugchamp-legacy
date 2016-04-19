'use strict';

const _ = require('lodash');
const co = require('co');
const Combinatorics = require('js-combinatorics');
const config = require('config');
const moment = require('moment');
const ms = require('ms');

module.exports = function(app, cache, chance, database, io, self) {
    const AUTO_READY_THRESHOLD = ms(config.get('app.launch.autoReadyThreshold'));
    const GET_LAUNCH_HOLD_DEBOUNCE_MAX_WAIT = 5000;
    const GET_LAUNCH_HOLD_DEBOUNCE_WAIT = 1000;
    const READY_PERIOD = ms(config.get('app.launch.readyPeriod'));
    const ROLES = config.get('app.games.roles');
    const SEPARATE_CAPTAIN_POOL = config.get('app.draft.separateCaptainPool');
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
    var currentLaunchHolds = [];

    var launchAttemptActive = false;
    var launchAttemptStart = null;
    var readiesReceived = new Set();

    /**
     * @async
     */
    function getLaunchHolds(forceUpdate) {
        return co(function*() {
            let launchHolds = [];

            let availableServers = yield self.getAvailableServers(forceUpdate);
            if (_.size(availableServers) === 0) {
                launchHolds.push('availableServers');
            }

            if (SEPARATE_CAPTAIN_POOL) {
                if (captainsAvailable.size < 2) {
                    launchHolds.push('availableCaptains');
                }
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
                if (SEPARATE_CAPTAIN_POOL) {
                    let captainsReady = new Set(_.intersection([...captainsAvailable], [...readiesReceived]));
                    if (captainsReady.size < 2) {
                        launchHolds.push('readyCaptains');
                    }
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

            return launchHolds;
        });
    }

    /**
     * @async
     */
    function updateLaunchStatusMessage() {
        return co(function*() {
            let launchStatusMessage = {
                roles: ROLES,
                rolesNeeded: calculateRolesNeeded(playersAvailable),
                teamSize: TEAM_SIZE,
                launchHolds: currentLaunchHolds,
                active: launchAttemptActive
            };

            if (launchAttemptActive) {
                launchStatusMessage.startTime = launchAttemptStart;
                launchStatusMessage.endTime = launchAttemptStart + READY_PERIOD;
            }

            launchStatusMessage.playersAvailable = {};
            for (let role of _.keys(ROLES)) {
                launchStatusMessage.playersAvailable[role] = yield _.map([...playersAvailable[role]], user => self.getCachedUser(user));
            }

            launchStatusMessage.allPlayersAvailable = _.unionBy(..._.values(launchStatusMessage.playersAvailable), user => self.getDocumentID(user));

            if (SEPARATE_CAPTAIN_POOL) {
                launchStatusMessage.captainsAvailable = yield _.map([...captainsAvailable], user => self.getCachedUser(user));
            }

            yield cache.setAsync('launchStatus', JSON.stringify(launchStatusMessage));

            io.sockets.emit('launchStatusUpdated', yield getLaunchStatusMessage());
        });
    }

    /**
     * @async
     */
    function getLaunchStatusMessage() {
        return co(function*() {
            let cacheResponse = yield cache.getAsync('launchStatus');

            if (!cacheResponse) {
                yield updateLaunchStatusMessage();
                cacheResponse = yield cache.getAsync('launchStatus');
            }

            let launchStatusMessage = JSON.parse(cacheResponse);

            launchStatusMessage.currentTime = Date.now();

            return launchStatusMessage;
        });
    }

    /**
     * @async
     */
    function attemptLaunch() {
        return co(function*() {
            try {
                currentLaunchHolds = yield getLaunchHolds(true);

                playersAvailable = _.mapValues(playersAvailable, function(available) {
                    return new Set(_.intersection([...available], [...readiesReceived]));
                });

                if (SEPARATE_CAPTAIN_POOL) {
                    captainsAvailable = new Set(_.intersection([...captainsAvailable], [...readiesReceived]));
                }
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

                yield self.updateLaunchStatus();

                return;
            }

            if (_.size(currentLaunchHolds) === 0) {
                try {
                    yield self.launchDraft({
                        players: _.mapValues(playersAvailable, function(available) {
                            return [...available];
                        }),
                        captains: SEPARATE_CAPTAIN_POOL ? [...captainsAvailable] : undefined
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

                    yield self.cleanUpDraft();
                }
            }
            else {
                self.sendMessage({
                    action: 'failed to launch new draft due to holds'
                });
            }

            launchAttemptActive = false;
            launchAttemptStart = null;

            yield self.updateLaunchStatus();
        });
    }

    function syncUserAvailability(user) {
        let userID = self.getDocumentID(user);

        self.emitToUser(userID, 'userAvailabilityUpdated', [{
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: SEPARATE_CAPTAIN_POOL ? captainsAvailable.has(userID) : undefined
        }]);
    }

    /**
     * @async
     */
    function updateUserAvailability(user, availability) {
        return co(function*() {
            let userID = self.getDocumentID(user);
            let userRestrictions = yield self.getUserRestrictions(user);

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

            if (SEPARATE_CAPTAIN_POOL) {
                if (!_.includes(userRestrictions.aspects, 'captain')) {
                    if (availability.captain) {
                        captainsAvailable.add(userID);
                    }
                    else {
                        captainsAvailable.delete(userID);
                    }
                }
            }

            syncUserAvailability(user);

            yield self.updateLaunchStatus();
        });
    }

    /**
     * @async
     */
    function updateUserReadyStatus(user, ready) {
        return co(function*() {
            let userID = self.getDocumentID(user);

            if (launchAttemptActive) {
                if (ready) {
                    readiesReceived.add(userID);
                }
                else {
                    readiesReceived.delete(userID);
                }

                self.emitToUser(user, 'userReadyStatusUpdated', [ready]);
            }

            yield self.updateLaunchStatus();
        });
    }

    /**
     * @async
     */
    function autoReadyRecentlyActiveUsers() {
        return co(function*() {
            let activeUsers = _.filter([...lastActivity.keys()], userID => (moment().diff(lastActivity.get(userID)) < AUTO_READY_THRESHOLD));

            yield _.map(activeUsers, userID => updateUserReadyStatus(userID, true));
        });
    }

    /**
     * @async
     */
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

                    yield autoReadyRecentlyActiveUsers();

                    currentLaunchHolds = yield getLaunchHolds(false);

                    yield updateLaunchStatusMessage();
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

                    yield self.updateLaunchStatus();
                }
            }
        });
    }

    /**
     * @async
     */
    const updateLaunchHolds = _.debounce(co.wrap(function* updateLaunchHolds() {
        let shouldAttemptLaunch = !launchAttemptActive;

        currentLaunchHolds = yield getLaunchHolds(false);

        yield updateLaunchStatusMessage();

        if (shouldAttemptLaunch && _.size(currentLaunchHolds) === 0) {
            yield beginLaunchAttempt();
        }
    }), GET_LAUNCH_HOLD_DEBOUNCE_WAIT, {
        maxWait: GET_LAUNCH_HOLD_DEBOUNCE_MAX_WAIT
    });

    self.markUserActivity = function markUserActivity(user) {
        let userID = self.getDocumentID(user);

        lastActivity.set(userID, new Date());
    };

    /**
     * @async
     */
    self.updateLaunchStatus = co.wrap(function* updateLaunchStatus() {
        yield updateLaunchStatusMessage();

        yield updateLaunchHolds();
    });

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('launchStatusUpdated', yield getLaunchStatusMessage());
    }));

    function onUserUpdateAvailability(availability) {
        let userID = this.decoded_token.user;

        co(function*() {
            self.markUserActivity(userID);

            yield updateUserAvailability(userID, availability);

            if (launchAttemptActive) {
                yield updateUserReadyStatus(userID, true);
            }
        });
    }

    function onUserUpdateReadyStatus(ready) {
        let userID = this.decoded_token.user;

        co(function*() {
            self.markUserActivity(userID);

            yield updateUserReadyStatus(userID, ready);
        });
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
            captain: SEPARATE_CAPTAIN_POOL ? captainsAvailable.has(userID) : undefined
        });
    });

    self.on('userDisconnected', co.wrap(function*(userID) {
        yield updateUserAvailability(userID, {
            roles: [],
            captain: SEPARATE_CAPTAIN_POOL ? false : undefined
        });

        yield updateUserReadyStatus(userID, false);
    }));

    self.on('userRestrictionsUpdated', co.wrap(function*(userID) {
        let userRestrictions = yield self.getUserRestrictions(userID);

        if (_.includes(userRestrictions.aspects, 'start')) {
            _.forEach(playersAvailable, function(players) {
                players.delete(userID);
            });
        }

        if (SEPARATE_CAPTAIN_POOL) {
            if (_.includes(userRestrictions.aspects, 'captain')) {
                captainsAvailable.delete(userID);
            }
        }

        syncUserAvailability(userID);

        yield self.updateLaunchStatus();
    }));

    co(function*() {
        yield self.updateLaunchStatus();
    });
};
