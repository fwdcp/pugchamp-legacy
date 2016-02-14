/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');

module.exports = function(app, chance, database, io, self) {
    const CAPTAIN_SELECTION_WEIGHT = config.get('app.draft.captainSelectionWeight');
    const DRAFT_ORDER = config.get('app.draft.order');
    const MAP_POOL = config.get('app.games.maps');
    const ROLES = config.get('app.games.roles');
    const TEAM_SIZE = config.get('app.games.teamSize');
    const TURN_TIME_LIMIT = ms(config.get('app.draft.turnTimeLimit'));

    function calculateRoleDistribution(currentTeam) {
        return _.reduce(currentTeam, function(roles, player) {
            roles[player.role]++;

            return roles;
        }, _.mapValues(ROLES, function() {
            return 0;
        }));
    }

    function calculateCurrentTeamState(team) {
        let currentRoleDistribution = calculateRoleDistribution(team);

        let currentState = _.reduce(ROLES, function(current, role, roleName) {
            current.players += currentRoleDistribution[roleName];

            if (currentRoleDistribution[roleName] < role.min) {
                current.underfilledRoles.push(roleName);
                current.underfilledTotal += role.min - currentRoleDistribution[roleName];
            }

            if (currentRoleDistribution[roleName] >= role.max) {
                current.filledRoles.push(roleName);
                current.overfilledTotal += currentRoleDistribution[roleName] - role.max;
            }

            return current;
        }, {
            players: 0,
            underfilledRoles: [],
            underfilledTotal: 0,
            filledRoles: [],
            overfilledTotal: 0
        });

        currentState.remaining = TEAM_SIZE - currentState.players;

        return currentState;
    }

    var draftActive = false;
    var draftComplete = false;

    var playerPool = _.mapValues(ROLES, function() {
        return [];
    });
    var fullPlayerList = [];
    var draftCaptains = [];
    var currentDraftTurn = 0;
    var currentDraftTurnStartTime = null;
    var currentDraftTurnExpireTimeout = null;
    var draftChoices = [];

    var teamFactions = [];
    var pickedTeams = [
        [],
        []
    ];
    var unavailablePlayers = [];
    var pickedMap = null;
    var remainingMaps = [];
    var allowedRoles = [];
    var overrideRoles = [];

    var currentDraftGame = null;

    var currentStatusInfo;

    self.isDraftActive = function isDraftActive() {
        return draftActive;
    };

    self.getCurrentDraftGame = function getCurrentDraftGame() {
        return currentDraftGame;
    };

    function checkIfLegalState(teams, maps, factions, final) {
        let teamsValid = _.every(teams, function(team) {
            let teamState = calculateCurrentTeamState(team);

            if (teamState.remaining < 0) {
                return false;
            }

            if (teamState.remaining < teamState.underfilledTotal) {
                return false;
            }

            if (teamState.overfilledTotal > 0) {
                return false;
            }

            if (final) {
                if (teamState.remaining !== 0) {
                    return false;
                }

                if (teamState.underfilledTotal > 0) {
                    return false;
                }
            }

            return true;
        });

        if (!teamsValid) {
            return false;
        }

        if (!maps.picked && _.size(maps.remaining) === 0) {
            return false;
        }

        if (final) {
            if (!maps.picked) {
                return false;
            }

            if (_(factions).intersection(['RED', 'BLU']).size() !== 2) {
                return false;
            }

            if (factions[0] === factions[1]) {
                return false;
            }
        }

        return true;
    }

    function updateStatusInfo() {
        currentStatusInfo = {
            roles: ROLES,
            teamSize: TEAM_SIZE,
            draftTurns: _.map(DRAFT_ORDER, function(turn, index) {
                let completeTurn = _.defaults({}, turn, draftChoices[index]);

                if (completeTurn.player) {
                    completeTurn.player = self.getCachedUser(completeTurn.player);
                }

                return completeTurn;
            }),
            playerPool: _.mapValues(playerPool, function(rolePool) {
                return _.map(rolePool, function(userID) {
                    return self.getCachedUser(userID);
                });
            }),
            fullPlayerList: _.map(fullPlayerList, function(userID) {
                return self.getCachedUser(userID);
            }),
            mapPool: MAP_POOL,
            draftCaptains: _.map(draftCaptains, function(userID) {
                return self.getCachedUser(userID);
            }),
            currentDraftTurn: currentDraftTurn,
            teamFactions: teamFactions,
            pickedTeams: _.map(pickedTeams, function(team) {
                return _.map(team, function(player) {
                    let filteredPlayer = _.clone(player);

                    filteredPlayer.player = self.getCachedUser(player.player);

                    return filteredPlayer;
                });
            }),
            unavailablePlayers: unavailablePlayers,
            pickedMap: pickedMap,
            remainingMaps: remainingMaps,
            allowedRoles: allowedRoles,
            overrideRoles: overrideRoles,
            active: draftActive,
            complete: draftComplete
        };
    }

    function getCurrentStatusMessage() {
        if (draftActive && !draftComplete) {
            currentStatusInfo.timeElapsed = Date.now() - currentDraftTurnStartTime;
            currentStatusInfo.timeTotal = TURN_TIME_LIMIT;
        }
        else {
            delete currentStatusInfo.timeElapsed;
            delete currentStatusInfo.timeTotal;
        }

        return currentStatusInfo;
    }

    self.cleanUpDraft = function cleanUpDraft() {
        // NOTE: this is somewhat of a hack to keep players active after a draft ends
        _.each(fullPlayerList, function(userID) {
            self.markUserActivity(userID);
        });

        draftActive = false;
        draftComplete = false;

        playerPool = _.mapValues(ROLES, function() {
            return [];
        });
        fullPlayerList = [];
        draftCaptains = [];
        currentDraftTurn = 0;
        currentDraftTurnStartTime = null;
        if (currentDraftTurnExpireTimeout) {
            clearTimeout(currentDraftTurnExpireTimeout);
            currentDraftTurnExpireTimeout = null;
        }
        draftChoices = [];

        teamFactions = [];
        pickedTeams = [
            [],
            []
        ];
        unavailablePlayers = [];
        pickedMap = null;
        remainingMaps = [];
        allowedRoles = [];
        overrideRoles = [];

        currentDraftGame = null;

        updateStatusInfo();
        io.sockets.emit('draftStatusUpdated', getCurrentStatusMessage());

        self.updateLaunchStatus();
    };

    function launchGameFromDraft() {
        return co(function*() {
            let game = new database.Game();
            game.status = 'initializing';
            game.date = new Date();
            game.map = pickedMap;

            game.teams = _.map(pickedTeams, function(team, teamNumber) {
                return {
                    captain: draftCaptains[teamNumber],
                    faction: teamFactions[teamNumber],
                    composition: _.map(team, function(player) {
                        return {
                            role: player.role,
                            players: [{
                                user: player.player
                            }]
                        };
                    })
                };
            });

            game.draft.choices = _.map(draftChoices, function(choice, index) {
                return _.assign({}, choice, DRAFT_ORDER[index]);
            });
            game.draft.pool.maps = _.keys(MAP_POOL);
            game.draft.pool.players = _(playerPool).transform(function(pool, players, role) {
                _.each(players, function(player) {
                    if (!pool[player]) {
                        pool[player] = [];
                    }

                    pool[player].push(role);
                });
            }).map(function(roles, player) {
                return {
                    user: player,
                    roles: roles
                };
            }).value();

            try {
                yield game.save();

                self.updateGameCache();

                _.each(game.teams, function(team) {
                    self.updateUserRestrictions(self.getDocumentID(team.captain));

                    _.each(team.composition, function(role) {
                        _.each(role.players, function(player) {
                            self.updateUserRestrictions(self.getDocumentID(player.user));
                        });
                    });
                });

                currentDraftGame = game.id;

                yield self.assignGameToServer(game);
            }
            catch (err) {
                self.postToLog({
                    description: 'encountered error while trying to set up game',
                    error: err
                });

                self.sendMessage({
                    action: 'failed to set up drafted game due to internal error'
                });

                self.cleanUpDraft();
            }
        });
    }

    function completeDraft() {
        return co(function*() {
            draftComplete = true;

            let legalNewState = checkIfLegalState(pickedTeams, {
                picked: pickedMap,
                remaining: remainingMaps
            }, teamFactions, true);

            if (!legalNewState) {
                throw new Error('Invalid state after draft completed!');
            }

            currentDraftTurn = _.size(DRAFT_ORDER);

            allowedRoles = [];
            overrideRoles = [];

            unavailablePlayers = _(pickedTeams).flatten().map(function(pick) {
                return pick.player;
            }).union(draftCaptains).uniq().value();

            currentDraftTurnStartTime = Date.now();

            updateStatusInfo();
            io.sockets.emit('draftStatusUpdated', getCurrentStatusMessage());

            yield launchGameFromDraft();
        });
    }

    function commitDraftChoice(choice) {
        if (!draftActive || draftComplete) {
            return;
        }

        try {
            let turnDefinition = DRAFT_ORDER[currentDraftTurn];

            if (turnDefinition.method === 'captain' && choice.captain !== draftCaptains[turnDefinition.captain]) {
                return;
            }
            else if (turnDefinition.method !== 'captain' && choice.captain) {
                return;
            }

            if (turnDefinition.type !== choice.type) {
                return;
            }

            let newFactions = _.cloneDeep(teamFactions);
            let newTeams = _.cloneDeep(pickedTeams);
            let newPickedMap = pickedMap;
            let newRemainingMaps = _.cloneDeep(remainingMaps);

            if (turnDefinition.type === 'factionSelect') {
                if (choice.faction !== 'RED' && choice.faction !== 'BLU') {
                    return;
                }

                if (turnDefinition.captain === 0) {
                    if (choice.faction === 'RED') {
                        newFactions = ['RED', 'BLU'];
                    }
                    else if (choice.faction === 'BLU') {
                        newFactions = ['BLU', 'RED'];
                    }
                }
                else if (turnDefinition.captain === 1) {
                    if (choice.faction === 'RED') {
                        newFactions = ['BLU', 'RED'];
                    }
                    else if (choice.faction === 'BLU') {
                        newFactions = ['RED', 'BLU'];
                    }
                }
            }
            else if (turnDefinition.type === 'playerPick') {
                if (_.includes(unavailablePlayers, choice.player)) {
                    return;
                }

                if (!_.includes(allowedRoles, choice.role)) {
                    return;
                }

                if (choice.override) {
                    if (!_.includes(overrideRoles, choice.role)) {
                        return;
                    }
                }
                else {
                    if (!_.includes(playerPool[choice.role], choice.player)) {
                        return;
                    }
                }

                newTeams[turnDefinition.captain].push({
                    player: choice.player,
                    role: choice.role
                });
            }
            else if (turnDefinition.type === 'captainRole') {
                if (!_.includes(allowedRoles, choice.role)) {
                    return;
                }

                newTeams[turnDefinition.captain].push({
                    player: draftCaptains[turnDefinition.captain],
                    role: choice.role
                });
            }
            else if (turnDefinition.type === 'mapBan') {
                if (!_.includes(remainingMaps, choice.map)) {
                    return;
                }

                newRemainingMaps = _.without(remainingMaps, choice.map);
            }
            else if (turnDefinition.type === 'mapPick') {
                if (!_.includes(remainingMaps, choice.map)) {
                    return;
                }

                newPickedMap = choice.map;
                newRemainingMaps = _.without(remainingMaps, choice.map);
            }

            let legalNewState = checkIfLegalState(newTeams, {
                picked: newPickedMap,
                remaining: newRemainingMaps
            }, newFactions, false);

            if (!legalNewState) {
                throw new Error('Invalid state after valid choice!');
            }

            teamFactions = newFactions;
            pickedTeams = newTeams;
            pickedMap = newPickedMap;
            remainingMaps = newRemainingMaps;

            draftChoices.push(choice);

            if (currentDraftTurnExpireTimeout) {
                clearTimeout(currentDraftTurnExpireTimeout);
            }

            if (currentDraftTurn + 1 === _.size(DRAFT_ORDER)) {
                completeDraft();
            }
            else {
                beginDraftTurn(++currentDraftTurn);
            }
        }
        catch (err) {
            self.postToLog({
                description: 'error in committing draft choice: `' + JSON.stringify(choice) + '`',
                error: err
            });

            self.sendMessage({
                action: 'game draft aborted due to internal error'
            });

            self.cleanUpDraft();
        }
    }

    function makeRandomChoice() {
        let turnDefinition = DRAFT_ORDER[currentDraftTurn];

        try {
            let choice = {
                type: turnDefinition.type
            };

            if (turnDefinition.type === 'factionSelect') {
                choice.faction = chance.pick(['BLU', 'RED']);
            }
            else if (turnDefinition.type === 'playerPick') {
                choice.role = chance.pick(allowedRoles);

                if (_.includes(overrideRoles, choice.role)) {
                    choice.override = true;
                    choice.player = chance.pick(_.difference(fullPlayerList, unavailablePlayers));
                }
                else {
                    choice.player = chance.pick(_.difference(playerPool[choice.role], unavailablePlayers));
                }
            }
            else if (turnDefinition.type === 'captainRole') {
                choice.role = chance.pick(allowedRoles);
            }
            else if (turnDefinition.type === 'mapBan' || turnDefinition.type === 'mapPick') {
                choice.type = turnDefinition.type;

                choice.map = chance.pick(remainingMaps);
            }

            commitDraftChoice(choice);
        }
        catch (err) {
            self.postToLog({
                description: 'error in making random choice: `' + JSON.stringify(turnDefinition) + '`',
                error: err
            });

            self.sendMessage({
                action: 'game draft aborted due to internal error'
            });

            self.cleanUpDraft();
        }
    }

    function expireTime() {
        self.sendMessage({
            action: 'game draft aborted due to turn expiration'
        });

        self.cleanUpDraft();
    }

    function beginDraftTurn(turn) {
        currentDraftTurn = turn;

        unavailablePlayers = _(pickedTeams).flatten().map(function(pick) {
            return pick.player;
        }).union(draftCaptains).uniq().value();

        let turnDefinition = DRAFT_ORDER[turn];

        if (turnDefinition.type === 'playerPick' || turnDefinition.type === 'captainRole') {
            let team = pickedTeams[turnDefinition.captain];
            let teamState = calculateCurrentTeamState(team);

            if (teamState.remaining > teamState.underfilledTotal) {
                allowedRoles = _.difference(_.keys(ROLES), teamState.filledRoles);
            }
            else {
                allowedRoles = teamState.underfilledRoles;
            }

            overrideRoles = _.filter(teamState.underfilledRoles, function(role) {
                return !ROLES[role].overrideImmune && _(playerPool[role]).difference(unavailablePlayers).size() === 0;
            });
        }
        else {
            allowedRoles = [];
            overrideRoles = [];
        }

        currentDraftTurnStartTime = Date.now();
        currentDraftTurnExpireTimeout = setTimeout(expireTime, TURN_TIME_LIMIT);

        updateStatusInfo();
        io.sockets.emit('draftStatusUpdated', getCurrentStatusMessage());

        if (turnDefinition.method === 'random') {
            makeRandomChoice();
        }
    }

    function selectCaptains(captains) {
        return co(function*() {
            let fullCaptains = yield database.User.find({
                _id: {
                    $in: captains
                }
            }).exec();

            let weights;

            if (CAPTAIN_SELECTION_WEIGHT === 'equal') {
                weights = new Array(_.size(fullCaptains));
                _.fill(weights, 1, 0, _.size(fullCaptains));
            }
            else if (CAPTAIN_SELECTION_WEIGHT === 'success') {
                weights = _.map(fullCaptains, function(captain) {
                    if (_.isNumber(captain.stats.captainScore.low)) {
                        return Math.sqrt(Number.EPSILON) + captain.stats.captainScore.low;
                    }

                    return Math.sqrt(Number.EPSILON);
                });
            }

            let chosenCaptains = new Set();

            while (chosenCaptains.size < 2) {
                let newCaptain = chance.weighted(fullCaptains, weights);

                if (newCaptain) {
                    chosenCaptains.add(newCaptain);
                }
            }

            draftCaptains = _([...chosenCaptains]).take(2).map(captain => captain.id).value();

            return draftCaptains;
        });
    }

    self.launchDraft = co.wrap(function* launchDraft(draftInfo) {
        draftActive = true;
        draftComplete = false;

        playerPool = draftInfo.players;
        fullPlayerList = _.reduce(playerPool, function(allPlayers, players) {
            return _.union(allPlayers, players);
        }, []);

        remainingMaps = _.keys(MAP_POOL);

        teamFactions = [];
        pickedTeams = [
            [],
            []
        ];
        pickedMap = null;

        currentDraftGame = null;

        yield selectCaptains(draftInfo.captains);

        let legalState = checkIfLegalState(pickedTeams, {
            picked: pickedMap,
            remaining: remainingMaps
        }, teamFactions, false);

        if (!legalState) {
            throw new Error('Invalid state before draft start!');
        }

        beginDraftTurn(0);
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('draftStatusUpdated', getCurrentStatusMessage());
    });

    function onUserMakeDraftChoice(choice) {
        /*jshint validthis: true */
        let userID = this.decoded_token.user;

        choice.captain = userID;

        commitDraftChoice(choice);
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('makeDraftChoice');
        socket.on('makeDraftChoice', onUserMakeDraftChoice);
    });

    updateStatusInfo();
};
