'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');

module.exports = function(app, chance, database, io, self) {
    const CAPTAIN_DRAFT_EXPIRE_COOLDOWN = ms(config.get('app.draft.captainDraftExpireCooldown'));
    const DRAFT_ORDER = config.get('app.draft.order');
    const MAP_POOL = config.get('app.games.maps');
    const ROLES = config.get('app.games.roles');
    const SEPARATE_CAPTAIN_POOL = config.get('app.draft.separateCaptainPool');
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

    var currentDraftExpireCooldowns = new Set();

    self.isOnDraftExpireCooldown = function isOnDraftExpireCooldown(userID) {
        return currentDraftExpireCooldowns.has(userID);
    };

    function removeDraftExpireCooldown(userID) {
        currentDraftExpireCooldowns.delete(userID);

        self.updateUserRestrictions(userID);
    }

    var draftActive = false;
    var draftComplete = false;

    var playerPool = _.mapValues(ROLES, function() {
        return [];
    });
    var captainPool = [];
    var fullPlayerList = [];
    var draftCaptains = [];
    var currentDraftTurn = 0;
    var currentDraftTurnStartTime = null;
    var currentDraftTurnExpireTimeout = null;
    var draftChoices = [];

    var teamFactions = [];
    var pickedTeams = [];
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

    self.getDraftPlayers = function getDraftPlayers() {
        if (draftActive && !draftComplete) {
            return _.set(captainPool, fullPlayerList);
        }
        else {
            return [];
        }
    };

    function checkIfLegalState(captains, teams, maps, factions, final) {
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
            if (_.size(captains) !== 2 || !captains[0] || !captains[1]) {
                return false;
            }

            if (!maps.picked) {
                return false;
            }

            if (_(factions).intersection(['RED', 'BLU']).size() !== 2) {
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
            captainPool: _.map(captainPool, function(userID) {
                return self.getCachedUser(userID);
            }),
            fullPlayerList: _.map(fullPlayerList, function(userID) {
                return self.getCachedUser(userID);
            }),
            mapPool: MAP_POOL,
            draftCaptains: _.map(draftCaptains, function(userID) {
                return self.getCachedUser(userID);
            }),
            currentDraftTurn,
            teamFactions,
            pickedTeams: _.map(pickedTeams, function(team) {
                return _.map(team, function(player) {
                    let filteredPlayer = _.clone(player);

                    filteredPlayer.player = self.getCachedUser(player.player);

                    return filteredPlayer;
                });
            }),
            unavailablePlayers,
            pickedMap,
            remainingMaps,
            allowedRoles,
            overrideRoles,
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
        // NOTE: we need to save these to perform operations once draft is cleared
        let previousDraftCaptains = captainPool;
        let previousDraftPlayers = fullPlayerList;

        draftActive = false;
        draftComplete = false;

        playerPool = _.mapValues(ROLES, function() {
            return [];
        });
        captainPool = [];
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
        pickedTeams = [];
        unavailablePlayers = [];
        pickedMap = null;
        remainingMaps = [];
        allowedRoles = [];
        overrideRoles = [];

        currentDraftGame = null;

        updateStatusInfo();
        io.sockets.emit('draftStatusUpdated', getCurrentStatusMessage());

        // NOTE: hacks with previous draft info - clear draft restrictions and mark activity to prevent players from getting removed
        _.each(previousDraftCaptains, function(captain) {
            self.markUserActivity(captain);
            self.updateUserRestrictions(captain);
        });
        _.each(previousDraftPlayers, function(player) {
            self.markUserActivity(player);
            self.updateUserRestrictions(player);
        });

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
                    roles
                };
            }).value();
            game.draft.pool.captains = captainPool;

            try {
                yield game.save();

                self.emit('gameUpdated', game.id);

                _.each(draftCaptains, function(captain) {
                    self.updateUserRestrictions(captain);
                    self.updatePlayerStats(captain);
                });

                _.each(fullPlayerList, function(player) {
                    self.updateUserRestrictions(player);
                    self.updatePlayerStats(player);
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

            let legalNewState = checkIfLegalState(draftCaptains, pickedTeams, {
                picked: pickedMap,
                remaining: remainingMaps
            }, teamFactions, true);

            if (!legalNewState) {
                throw new Error('invalid state after draft completed');
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

            if (turnDefinition.method === 'captain' && choice.user !== draftCaptains[turnDefinition.team]) {
                return;
            }
            else if (turnDefinition.method !== 'captain' && choice.user) {
                return;
            }

            if (turnDefinition.type !== choice.type) {
                return;
            }

            let newCaptains = _.cloneDeep(draftCaptains);
            let newFactions = _.cloneDeep(teamFactions);
            let newTeams = _.cloneDeep(pickedTeams);
            let newPickedMap = pickedMap;
            let newRemainingMaps = _.cloneDeep(remainingMaps);

            if (turnDefinition.type === 'factionSelect') {
                if (choice.faction !== 'RED' && choice.faction !== 'BLU') {
                    return;
                }

                if (turnDefinition.team === 0) {
                    if (choice.faction === 'RED') {
                        newFactions = ['RED', 'BLU'];
                    }
                    else if (choice.faction === 'BLU') {
                        newFactions = ['BLU', 'RED'];
                    }
                }
                else if (turnDefinition.team === 1) {
                    if (choice.faction === 'RED') {
                        newFactions = ['BLU', 'RED'];
                    }
                    else if (choice.faction === 'BLU') {
                        newFactions = ['RED', 'BLU'];
                    }
                }
            }
            else if (turnDefinition.type === 'captainSelect') {
                if (_.some(unavailablePlayers, choice.captain) && !_.some(pickedTeams[turnDefinition.team], player => player.player === choice.captain)) {
                    return;
                }

                if (turnDefinition.team === 0) {
                    newCaptains = [choice.captain, draftCaptains[1]];
                }
                else if (turnDefinition.team === 1) {
                    newCaptains = [draftCaptains[0], choice.captain];
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

                newTeams[turnDefinition.team].push({
                    player: choice.player,
                    role: choice.role
                });
            }
            else if (turnDefinition.type === 'captainRole') {
                if (!_.includes(allowedRoles, choice.role)) {
                    return;
                }

                if (!draftCaptains[turnDefinition.team]) {
                    return;
                }

                newTeams[turnDefinition.team].push({
                    player: draftCaptains[turnDefinition.team],
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

            let legalNewState = checkIfLegalState(newCaptains, newTeams, {
                picked: newPickedMap,
                remaining: newRemainingMaps
            }, newFactions, false);

            if (!legalNewState) {
                throw new Error('invalid state after committing choice');
            }

            draftCaptains = newCaptains;
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
                description: `error in committing draft choice: \`${JSON.stringify(choice)}\``,
                error: err
            });

            self.sendMessage({
                action: 'game draft aborted due to internal error'
            });

            self.cleanUpDraft();
        }
    }

    function makeAutomatedChoice() {
        return co(function*() {
            let turnDefinition = DRAFT_ORDER[currentDraftTurn];

            try {
                let choice = {
                    type: turnDefinition.type
                };
                let supported = false;

                if (turnDefinition.type === 'factionSelect') {
                    if (turnDefinition.method === 'random') {
                        choice.faction = chance.pick(['BLU', 'RED']);

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'captainSelect') {
                    let turnCaptainPool = [];

                    if (turnDefinition.pool === 'global') {
                        turnCaptainPool = _.difference(captainPool, unavailablePlayers);
                    }
                    else if (turnDefinition.pool === 'team') {
                        turnCaptainPool = _(pickedTeams[turnDefinition.team]).map(player => player.player).intersection(captainPool).value();
                    }

                    if (_.size(turnCaptainPool) === 0) {
                        throw new Error('no potential captains to select from');
                    }

                    if (turnDefinition.method === 'random') {
                        choice.captain = chance.pick(turnCaptainPool);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'success') {
                        let fullCaptains = yield database.User.find({
                            _id: {
                                $in: turnCaptainPool
                            }
                        }).exec();

                        let weights = _.map(fullCaptains, function(captain) {
                            return _.isNumber(captain.stats.captainScore.center) ? captain.stats.captainScore.center : 0;
                        });

                        let boost = Math.sqrt(Number.EPSILON);
                        let minWeight = _.min(weights);
                        if (minWeight <= 0) {
                            boost += -1 * minWeight;
                        }

                        weights = _.map(weights, function(weight) {
                            return weight + boost;
                        });

                        choice.captain = chance.weighted(turnCaptainPool, weights);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'experience') {
                        choice.captain = _.maxBy(turnCaptainPool, function(captain) {
                            let user = self.getCachedUser(captain);

                            if (user.stats.roles) {
                                return _.reduce(user.stats.roles, (sum, stat) => sum + stat.count, 0);
                            }

                            return 0;
                        });

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'playerPick') {
                    if (turnDefinition.method === 'random') {
                        choice.role = chance.pick(allowedRoles);

                        if (_.includes(overrideRoles, choice.role)) {
                            choice.override = true;
                            choice.player = chance.pick(_.difference(fullPlayerList, unavailablePlayers));
                        }
                        else {
                            choice.player = chance.pick(_.difference(playerPool[choice.role], unavailablePlayers));
                        }

                        supported = true;
                    }
                    else if (turnDefinition.method === 'balance') {
                        let currentRoleDistribution = calculateRoleDistribution(pickedTeams[turnDefinition.team]);

                        choice.role = _.maxBy(allowedRoles, function(role) {
                            return (ROLES[role].min - currentRoleDistribution[role] + Math.sqrt(Number.EPSILON)) / (_(playerPool[choice.role]).difference(unavailablePlayers).size() + Math.sqrt(Number.EPSILON));
                        });

                        choice.override = _.includes(overrideRoles, choice.role);
                        let choicePool = choice.override ? _.difference(fullPlayerList, unavailablePlayers) : _.difference(playerPool[choice.role], unavailablePlayers);

                        let desiredRating = 1500;

                        let allyTeam = turnDefinition.team === 0 ? 0 : 1;
                        let enemyTeam = turnDefinition.team === 0 ? 1 : 0;
                        if (_.size(pickedTeams[allyTeam]) < _.size(pickedTeams[enemyTeam])) {
                            let allyTotalRating = _.sumBy(pickedTeams[allyTeam], function(player) {
                                let user = self.getCachedUser(player.player);

                                return user.stats.rating.mean;
                            });

                            let enemyTotalRating = _.sumBy(pickedTeams[enemyTeam], function(player) {
                                let user = self.getCachedUser(player.player);

                                return user.stats.rating.mean;
                            });

                            desiredRating = enemyTotalRating - allyTotalRating;
                        }
                        else {
                            desiredRating = _.sumBy(choicePool, function(player) {
                                let user = self.getCachedUser(player.player);

                                return user.stats.rating.mean;
                            }) / _.size(choicePool);
                        }

                        let sortedChoicePool = _.sortBy(choicePool, function(player) {
                            let user = self.getCachedUser(player.player);

                            return Math.abs(user.stats.rating.mean - desiredRating);
                        }, function(player) {
                            let user = self.getCachedUser(player.player);

                            return user.stats.rating.deviation;
                        });

                        choice.player = sortedChoicePool[0];

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'captainRole') {
                    if (turnDefinition.method === 'random') {
                        choice.role = chance.pick(allowedRoles);

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'mapBan') {
                    if (turnDefinition.method === 'random') {
                        choice.map = chance.pick(remainingMaps);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'fresh') {
                        let recentGames = yield _(pickedTeams).flatten().map(player => database.Game.findOne({'teams.composition.players.user': player.player}).sort({date: -1}).exec()).value();

                        let recentlyPlayedMap = _.chain(recentGames).reduce(function(maps, game) {
                            if (!game || !_.includes(remainingMaps, game.map)) {
                                return maps;
                            }

                            if (!maps[game.map]) {
                                maps[game.map] = 0;
                            }

                            maps[game.map]++;

                            return maps;
                        }, {}).toPairs().maxBy(pair => pair[1]).value();

                        if (recentlyPlayedMap) {
                            choice.map = recentlyPlayedMap[0];
                        }
                        else {
                            choice.map = chance.pick(remainingMaps);
                        }

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'mapPick') {
                    if (turnDefinition.method === 'random') {
                        choice.map = chance.pick(remainingMaps);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'fresh') {
                        let recentGames = yield _(pickedTeams).flatten().map(player => database.Game.findOne({'teams.composition.players.user': player.player}).sort({date: -1}).exec()).value();

                        let recentlyPlayedMap = _.chain(recentGames).reduce(function(maps, game) {
                            if (!game || !_.includes(remainingMaps, game.map)) {
                                return maps;
                            }

                            if (!maps[game.map]) {
                                maps[game.map] = 0;
                            }

                            maps[game.map]++;

                            return maps;
                        }, {}).toPairs().minBy(pair => pair[1]).value();

                        if (recentlyPlayedMap) {
                            choice.map = recentlyPlayedMap[0];
                        }
                        else {
                            choice.map = chance.pick(remainingMaps);
                        }

                        supported = true;
                    }
                }

                if (!supported) {
                    throw new Error('unsupported turn type');
                }

                commitDraftChoice(choice);
            }
            catch (err) {
                self.postToLog({
                    description: `error in making automated choice: \`${JSON.stringify(turnDefinition)}\``,
                    error: err
                });

                self.sendMessage({
                    action: 'game draft aborted due to internal error'
                });

                self.cleanUpDraft();
            }
        });
    }

    function expireTime() {
        let turnDefinition = DRAFT_ORDER[currentDraftTurn];

        if (turnDefinition.method === 'captain') {
            let captain = draftCaptains[turnDefinition.team];

            if (captain) {
                currentDraftExpireCooldowns.add(captain);

                self.updateUserRestrictions(captain);

                setTimeout(removeDraftExpireCooldown, CAPTAIN_DRAFT_EXPIRE_COOLDOWN, captain);
            }
        }

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
            let team = pickedTeams[turnDefinition.team];
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

        if (turnDefinition.method === 'captain') {
            if (!draftCaptains[turnDefinition.team]) {
                throw new Error('no captain to perform selection');
            }
        }
        else {
            makeAutomatedChoice();
        }
    }

    self.launchDraft = function launchDraft(draftInfo) {
        draftActive = true;
        draftComplete = false;

        playerPool = draftInfo.players;
        fullPlayerList = _.reduce(playerPool, function(allPlayers, players) {
            return _.union(allPlayers, players);
        }, []);
        if (SEPARATE_CAPTAIN_POOL) {
            captainPool = draftInfo.captains;
        }
        else {
            captainPool = _.filter(draftInfo.fullPlayerList, function(player) {
                let userRestrictions = self.getUserRestrictions(player);

                return !_.includes(userRestrictions.aspects, 'captain');
            });
        }

        remainingMaps = _.keys(MAP_POOL);

        draftCaptains = [];
        teamFactions = [];
        pickedTeams = [
            [],
            []
        ];
        pickedMap = null;

        currentDraftGame = null;

        let legalState = checkIfLegalState(draftCaptains, pickedTeams, {
            picked: pickedMap,
            remaining: remainingMaps
        }, teamFactions, false);

        if (!legalState) {
            throw new Error('invalid state before draft start');
        }

        _.each(captainPool, function(captain) {
            self.updateUserRestrictions(captain);
        });

        _.each(fullPlayerList, function(player) {
            self.updateUserRestrictions(player);
        });

        beginDraftTurn(0);
    };

    io.sockets.on('connection', function(socket) {
        socket.emit('draftStatusUpdated', getCurrentStatusMessage());
    });

    function onUserMakeDraftChoice(choice) {
        let userID = this.decoded_token.user;

        choice.user = userID;

        commitDraftChoice(choice);
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('makeDraftChoice');
        socket.on('makeDraftChoice', onUserMakeDraftChoice);
    });

    updateStatusInfo();
};
