'use strict';

const _ = require('lodash');
const co = require('co');
const Combinatorics = require('js-combinatorics');
const config = require('config');
const moment = require('moment');
const ms = require('ms');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const AUTO_READY_THRESHOLD = ms(config.get('app.launch.autoReadyThreshold'));
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
                    available: _.union(current.available, _.toArray(playersAvailable[roleName])),
                    required: current.required + (ROLES[roleName].min * 2)
                };
            }, {
                available: [],
                required: 0
            });

            let missing = combinationInfo.required - _.size(combinationInfo.available);

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
    function getLaunchHolds(fullCheck) {
        return co(function*() {
            let launchHolds = [];

            if (fullCheck) {
                let server = yield self.findAvailableServer();

                if (!server) {
                    launchHolds.push('availableServers');
                }
            }
            else {
                let serverStatuses = yield self.getServerStatuses();

                if (!_.some(serverStatuses, ['status', 'free'])) {
                    launchHolds.push('availableServers');
                }
            }

            if (SEPARATE_CAPTAIN_POOL) {
                if (captainsAvailable.size < 2) {
                    launchHolds.push('availableCaptains');
                }
            }

            let allPlayersAvailable = _.reduce(playersAvailable, function(allPlayers, players) {
                return _.union(allPlayers, _.toArray(players));
            }, []);
            if (_.size(allPlayersAvailable) < 2 * TEAM_SIZE) {
                launchHolds.push('availablePlayers');
            }

            let availablePlayerRolesNeeded = calculateRolesNeeded(playersAvailable);
            if (_.size(availablePlayerRolesNeeded) !== 0) {
                launchHolds.push('availablePlayerRoles');
            }

            if (launchAttemptActive) {
                if (SEPARATE_CAPTAIN_POOL) {
                    let captainsReady = _.intersection(_.toArray(captainsAvailable), _.toArray(readiesReceived));
                    if (_.size(captainsReady) < 2) {
                        launchHolds.push('readyCaptains');
                    }
                }

                let allPlayersReady = _.intersection(allPlayersAvailable, _.toArray(readiesReceived));
                if (_.size(allPlayersReady) < 2 * TEAM_SIZE) {
                    launchHolds.push('readyPlayers');
                }

                let playersReady = _.mapValues(playersAvailable, available => new Set(_.intersection(_.toArray(available), _.toArray(readiesReceived))));
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
                launchStatusMessage.playersAvailable[role] = yield self.getCachedUsers(_.toArray(playersAvailable[role]));
            }

            launchStatusMessage.allPlayersAvailable = _.unionBy(..._.values(launchStatusMessage.playersAvailable), user => helpers.getDocumentID(user));

            if (SEPARATE_CAPTAIN_POOL) {
                launchStatusMessage.captainsAvailable = yield self.getCachedUsers(_.toArray(captainsAvailable));
            }

            yield cache.setAsync('launchStatus', JSON.stringify(launchStatusMessage));

            io.sockets.emit('launchStatusUpdated', launchStatusMessage);
        });
    }

    /**
     * @async
     */
    function getLaunchStatusMessage() {
        return co(function*() {
            if (!(yield cache.existsAsync('launchStatus'))) {
                yield updateLaunchStatusMessage();
            }

            return JSON.parse(yield cache.getAsync('launchStatus'));
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
                    return new Set(_.intersection(_.toArray(available), _.toArray(readiesReceived)));
                });

                if (SEPARATE_CAPTAIN_POOL) {
                    captainsAvailable = new Set(_.intersection(_.toArray(captainsAvailable), _.toArray(readiesReceived)));
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

                self.processLaunchStatusUpdate();

                return;
            }

            if (_.size(currentLaunchHolds) === 0) {
                try {
                    yield self.launchDraft({
                        players: _.mapValues(playersAvailable, available => _.toArray(available)),
                        captains: SEPARATE_CAPTAIN_POOL ? _.toArray(captainsAvailable) : undefined
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

            self.processLaunchStatusUpdate();
        });
    }

    function syncUserAvailability(user) {
        let userID = helpers.getDocumentID(user);

        self.emitToUser(userID, 'userAvailabilityUpdated', {
            roles: _.mapValues(playersAvailable, function(players) {
                return players.has(userID);
            }),
            captain: SEPARATE_CAPTAIN_POOL ? captainsAvailable.has(userID) : undefined
        });
    }

    /**
     * @async
     */
    function updateUserAvailability(user, availability) {
        return co(function*() {
            let userID = helpers.getDocumentID(user);
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

            self.processLaunchStatusUpdate();
        });
    }

    /**
     * @async
     */
    function updateUserReadyStatus(user, ready) {
        let userID = helpers.getDocumentID(user);

        if (launchAttemptActive) {
            if (ready) {
                readiesReceived.add(userID);
            }
            else {
                readiesReceived.delete(userID);
            }

            self.emitToUser(user, 'userReadyStatusUpdated', ready);
        }

        self.processLaunchStatusUpdate();
    }

    /**
     * @async
     */
    function autoReadyRecentlyActiveUsers() {
        let activeUsers = _(lastActivity.keys()).toArray().filter(userID => (moment().diff(lastActivity.get(userID)) < AUTO_READY_THRESHOLD)).value();

        for (let userID of activeUsers) {
            updateUserReadyStatus(userID, true);
        }
    }

    /**
     * @async
     */
    function beginLaunchAttempt() {
        return co(function*() {
            if (!launchAttemptActive) {
                try {
                    setTimeout(attemptLaunch, READY_PERIOD);

                    launchAttemptActive = true;
                    launchAttemptStart = Date.now();

                    readiesReceived = new Set();

                    io.sockets.emit('userReadyStatusUpdated', false);

                    autoReadyRecentlyActiveUsers();

                    currentLaunchHolds = yield getLaunchHolds(false);

                    self.processLaunchStatusUpdate();
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

                    self.processLaunchStatusUpdate();
                }
            }
        });
    }

    self.markUserActivity = function markUserActivity(user) {
        let userID = helpers.getDocumentID(user);

        lastActivity.set(userID, new Date());
    };

    /**
     * @async
     */
    self.processLaunchStatusUpdate = _.debounce(co.wrap(function* processLaunchStatusUpdate() {
        let shouldAttemptLaunch = !launchAttemptActive;

        currentLaunchHolds = yield getLaunchHolds(false);

        if (shouldAttemptLaunch && _.size(currentLaunchHolds) === 0) {
            yield beginLaunchAttempt();
        }
        else {
            yield updateLaunchStatusMessage();
        }
    }));

    self.on('draftStatusChanged', function() {
        self.processLaunchStatusUpdate();
    });

    self.on('serversUpdated', function() {
        self.processLaunchStatusUpdate();
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
                updateUserReadyStatus(userID, true);
            }
        });
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
            captain: SEPARATE_CAPTAIN_POOL ? captainsAvailable.has(userID) : undefined
        });
    });

    self.on('userDisconnected', co.wrap(function*(userID) {
        yield updateUserAvailability(userID, {
            roles: [],
            captain: SEPARATE_CAPTAIN_POOL ? false : undefined
        });

        updateUserReadyStatus(userID, false);
    }));

    self.on('userRestrictionsUpdated', function(userID, userRestrictions) {
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

        self.processLaunchStatusUpdate();
    });

    self.processLaunchStatusUpdate();
};
