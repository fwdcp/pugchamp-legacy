'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');

module.exports = function(app, cache, chance, database, io, self) {
    const CAPTAIN_DRAFT_EXPIRE_COOLDOWN = ms(config.get('app.draft.captainDraftExpireCooldown'));
    const DRAFT_ORDER = config.get('app.draft.order');
    const EPSILON = Math.sqrt(Number.EPSILON);
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

    self.isOnDraftExpireCooldown = function isOnDraftExpireCooldown(user) {
        let userID = self.getDocumentID(user);

        return currentDraftExpireCooldowns.has(userID);
    };

    function removeDraftExpireCooldown(user) {
        let userID = self.getDocumentID(user);

        currentDraftExpireCooldowns.delete(userID);

        self.updateUserRestrictions(user);
    }

    var draftActive = false;
    var draftComplete = false;

    var playerPool = _.mapValues(ROLES, function() {
        return [];
    });
    var captainPool = [];
    var fullPlayerList = [];
    var currentDraftTurn = 0;
    var currentDraftTurnStartTime = null;
    var currentDraftTurnExpireTimeout = null;
    var draftChoices = [];

    var draftTeams = [];
    var unavailablePlayers = [];
    var pickedMap = null;
    var remainingMaps = [];
    var allowedRoles = [];
    var overrideRoles = [];

    var currentDraftGame = null;

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

    function checkIfLegalState(teams, maps, final) {
        let teamsValid = _.every(teams, function(team) {
            let teamState = calculateCurrentTeamState(team.players);

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
                if (!team.captain) {
                    return false;
                }

                if (team.faction !== 'RED' && team.faction !== 'BLU') {
                    return false;
                }

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

            if (teams[0].faction === teams[1].faction) {
                return false;
            }
        }

        return true;
    }

    function updateDraftStatusMessage() {
        return co(function*() {
            let draftStatusMessage = {
                active: draftActive,
                complete: draftComplete,
                draftTurns: _.map(DRAFT_ORDER, (turn, index) => _.merge({}, turn, draftChoices[index])),
                currentDraftTurn,
                turnStartTime: currentDraftTurnStartTime,
                turnEndTime: currentDraftTurnStartTime + TURN_TIME_LIMIT,
                roles: ROLES,
                teamSize: TEAM_SIZE,
                draftTeams: _.cloneDeep(draftTeams),
                playerPool: _.cloneDeep(playerPool),
                captainPool: _.cloneDeep(captainPool),
                fullPlayerList: _.cloneDeep(fullPlayerList),
                unavailablePlayers,
                mapPool: MAP_POOL,
                pickedMap,
                remainingMaps,
                allowedRoles,
                overrideRoles
            };

            for (let turn of draftStatusMessage.draftTurns) {
                if (turn.player) {
                    turn.player = yield self.getCachedUser(turn.player);
                }

                if (turn.captain) {
                    turn.captain = yield self.getCachedUser(turn.captain);
                }
            }

            for (let team of draftStatusMessage.draftTeams) {
                if (team.captain) {
                    team.captain = yield self.getCachedUser(team.captain);
                }

                for (let player of team.players) {
                    player.user = yield self.getCachedUser(player.user);
                }
            }

            for (let role of _.keys(ROLES)) {
                draftStatusMessage.playerPool[role] = yield _.map(draftStatusMessage.playerPool[role], user => self.getCachedUser(user));
            }

            draftStatusMessage.captainPool = yield _.map(draftStatusMessage.captainPool, user => self.getCachedUser(user));

            draftStatusMessage.fullPlayerList = yield _.map(draftStatusMessage.fullPlayerList, user => self.getCachedUser(user));

            yield cache.setAsync('draftStatus', JSON.stringify(draftStatusMessage));

            io.sockets.emit('draftStatusUpdated', yield getDraftStatusMessage());
        });
    }

    function getDraftStatusMessage() {
        return co(function*() {
            let cacheResponse = yield cache.getAsync('draftStatus');

            if (!cacheResponse) {
                yield updateDraftStatusMessage();
                cacheResponse = yield cache.getAsync('draftStatus');
            }

            let draftStatusMessage = JSON.parse(cacheResponse);

            draftStatusMessage.currentTime = Date.now();

            return draftStatusMessage;
        });
    }

    self.cleanUpDraft = co.wrap(function* cleanUpDraft() {
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
        currentDraftTurn = 0;
        currentDraftTurnStartTime = null;
        if (currentDraftTurnExpireTimeout) {
            clearTimeout(currentDraftTurnExpireTimeout);
            currentDraftTurnExpireTimeout = null;
        }
        draftChoices = [];

        draftTeams = [];
        unavailablePlayers = [];
        pickedMap = null;
        remainingMaps = [];
        allowedRoles = [];
        overrideRoles = [];

        currentDraftGame = null;

        yield updateDraftStatusMessage();

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
    });

    function launchGameFromDraft() {
        return co(function*() {
            let game = new database.Game();
            game.status = 'initializing';
            game.date = new Date();
            game.map = pickedMap;

            game.teams = _.map(draftTeams, function(team) {
                return {
                    captain: team.captain,
                    faction: team.faction,
                    composition: _.map(team.players, function(player) {
                        return {
                            role: player.role,
                            players: [{
                                user: player.user
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

                yield self.processGameUpdate(game);

                _.each(captainPool, function(captain) {
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

                yield self.cleanUpDraft();
            }
        });
    }

    function completeDraft() {
        return co(function*() {
            draftComplete = true;

            let legalNewState = checkIfLegalState(draftTeams, {
                picked: pickedMap,
                remaining: remainingMaps
            }, true);

            if (!legalNewState) {
                throw new Error('invalid state after draft completed');
            }

            currentDraftTurn = _.size(DRAFT_ORDER);

            allowedRoles = [];
            overrideRoles = [];

            unavailablePlayers = _(draftTeams).map(function(team) {
                return _(team.players).map(player => player.user).concat(team.captain).value();
            }).flatten().uniq().value();

            currentDraftTurnStartTime = Date.now();

            yield updateDraftStatusMessage();

            yield launchGameFromDraft();
        });
    }

    function commitDraftChoice(choice) {
        return co(function*() {
            if (!draftActive || draftComplete) {
                return;
            }

            try {
                let turnDefinition = DRAFT_ORDER[currentDraftTurn];

                if (turnDefinition.method === 'captain' && choice.user !== draftTeams[turnDefinition.team].captain) {
                    return;
                }
                else if (turnDefinition.method !== 'captain' && choice.user) {
                    return;
                }

                if (turnDefinition.type !== choice.type) {
                    return;
                }

                let newTeams = _.cloneDeep(draftTeams);
                let newPickedMap = pickedMap;
                let newRemainingMaps = _.cloneDeep(remainingMaps);

                if (turnDefinition.type === 'factionSelect') {
                    if (choice.faction !== 'RED' && choice.faction !== 'BLU') {
                        return;
                    }

                    let allyTeam = turnDefinition.team === 0 ? 0 : 1;
                    let enemyTeam = turnDefinition.team === 0 ? 1 : 0;

                    if (choice.faction === 'RED') {
                        newTeams[allyTeam].faction = 'RED';
                        newTeams[enemyTeam].faction = 'BLU';
                    }
                    else if (choice.faction === 'BLU') {
                        newTeams[allyTeam].faction = 'BLU';
                        newTeams[enemyTeam].faction = 'RED';
                    }
                }
                else if (turnDefinition.type === 'captainSelect') {
                    if (_.some(unavailablePlayers, choice.captain) && !_.some(draftTeams[turnDefinition.team].players, player => player.user === choice.captain)) {
                        return;
                    }

                    newTeams[turnDefinition.team].captain = choice.captain;
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

                    newTeams[turnDefinition.team].players.push({
                        user: choice.player,
                        role: choice.role
                    });
                }
                else if (turnDefinition.type === 'captainRole') {
                    if (!_.includes(allowedRoles, choice.role)) {
                        return;
                    }

                    if (!draftTeams[turnDefinition.team].captain) {
                        return;
                    }

                    newTeams[turnDefinition.team].players.push({
                        user: draftTeams[turnDefinition.team].captain,
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
                }, false);

                if (!legalNewState) {
                    throw new Error('invalid state after committing choice');
                }

                draftTeams = newTeams;
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

                yield self.cleanUpDraft();
            }
        });
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
                        turnCaptainPool = _(draftTeams[turnDefinition.team].players).map(player => player.user).intersection(captainPool).value();
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

                        let candidates = _.map(fullCaptains, captain => self.getDocumentID(captain));
                        let weights = _.map(fullCaptains, function(captain) {
                            return _.isNumber(captain.stats.captainScore.center) ? captain.stats.captainScore.center : 0;
                        });

                        let boost = EPSILON;
                        let minWeight = _.min(weights);
                        if (minWeight <= 0) {
                            boost += -1 * minWeight;
                        }

                        weights = _.map(weights, function(weight) {
                            return weight + boost;
                        });

                        choice.captain = chance.weighted(candidates, weights);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'success-random') {
                        let fullCaptains = yield database.User.find({
                            _id: {
                                $in: turnCaptainPool
                            }
                        }).exec();

                        let candidates = _.map(fullCaptains, captain => self.getDocumentID(captain));
                        let weights = _.map(fullCaptains, function(captain) {
                            return _.isNumber(captain.stats.captainScore.center) ? captain.stats.captainScore.center : 0;
                        });

                        let boost = EPSILON;
                        let minWeight = _.min(weights);
                        if (minWeight <= 0) {
                            boost += -1 * minWeight;
                        }

                        weights = _.map(weights, function(weight) {
                            return weight + boost;
                        });

                        let finalCandidates = [];

                        while (_.size(finalCandidates) < 2 && _.size(candidates) > 0) {
                            let candidate = chance.weighted(candidates, weights);

                            let index = _.indexOf(candidates, candidate);
                            _.pullAt(candidates, index);
                            _.pullAt(weights, index);

                            finalCandidates.push(candidate);
                        }

                        choice.captain = chance.pick(finalCandidates);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'experience') {
                        let fullCaptains = yield database.User.find({
                            '_id': {
                                $in: turnCaptainPool
                            }
                        }).exec();

                        choice.captain = _.maxBy(fullCaptains, function(captain) {
                            return captain.stats.total.player;
                        });

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'playerPick') {
                    if (turnDefinition.method === 'random') {
                        choice.role = chance.weighted(allowedRoles, _.map(allowedRoles, role => (_.has(ROLES[role].priority) ? ROLES[role].priority : 1)));
                        choice.override = _.includes(overrideRoles, choice.role);
                        choice.player = chance.pick(choice.override ? _.difference(fullPlayerList, unavailablePlayers) : _.difference(playerPool[choice.role], unavailablePlayers));

                        supported = true;
                    }
                    else if (turnDefinition.method === 'balance') {
                        let currentRoleDistribution = calculateRoleDistribution(draftTeams[turnDefinition.team].players);

                        choice.role = _.maxBy(allowedRoles, function(role) {
                            let playersNeeded = ROLES[role].min - currentRoleDistribution[role];
                            let playersAvailable = _(playerPool[role]).difference(unavailablePlayers).size();
                            let priority = _.has(ROLES[role].priority) ? ROLES[role].priority : 1;

                            return ((priority * playersNeeded) + EPSILON) / (playersAvailable + EPSILON);
                        });

                        choice.override = _.includes(overrideRoles, choice.role);

                        let choicePool = yield database.User.find({
                            _id: {
                                $in: choice.override ? _.difference(fullPlayerList, unavailablePlayers) : _.difference(playerPool[choice.role], unavailablePlayers)
                            }
                        }).exec();

                        if (_.size(choicePool) === 0) {
                            throw new Error('no players to choose from');
                        }

                        let desiredRating = 1500;

                        let allyTeam = turnDefinition.team === 0 ? 0 : 1;
                        let enemyTeam = turnDefinition.team === 0 ? 1 : 0;
                        if (_.size(draftTeams[allyTeam].players) < _.size(draftTeams[enemyTeam].players)) {
                            let allyPlayers = yield database.User.find({
                                _id: {
                                    $in: _.map(draftTeams[allyTeam].players, player => player.user)
                                }
                            }).exec();

                            let allyTotalRating = _.sumBy(allyPlayers, function(player) {
                                return player.stats.rating.mean;
                            });

                            let enemyPlayers = yield database.User.find({
                                _id: {
                                    $in: _.map(draftTeams[enemyTeam].players, player => player.user)
                                }
                            }).exec();

                            let enemyTotalRating = _.sumBy(enemyPlayers, function(player) {
                                return player.stats.rating.mean;
                            });

                            desiredRating = enemyTotalRating - allyTotalRating;
                        }
                        else {
                            desiredRating = _.sumBy(choicePool, function(player) {
                                return player.stats.rating.mean;
                            }) / _.size(choicePool);
                        }

                        let sortedChoicePool = _.sortBy(choicePool, function(player) {
                            return Math.abs(player.stats.rating.mean - desiredRating);
                        }, function(player) {
                            return player.stats.rating.deviation;
                        });

                        choice.player = sortedChoicePool[0].id;

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'captainRole') {
                    if (turnDefinition.method === 'random') {
                        choice.role = chance.weighted(allowedRoles, _.map(allowedRoles, role => (_.has(ROLES[role].priority) ? ROLES[role].priority : 1)));

                        supported = true;
                    }
                }
                else if (turnDefinition.type === 'mapBan') {
                    if (turnDefinition.method === 'random') {
                        choice.map = chance.pick(remainingMaps);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'fresh') {
                        let recentGames = yield _(draftTeams).map(team => team.players).flatten().uniq().map(player => database.Game.findOne({'teams.composition.players.user': player.user}).sort({date: -1}).exec()).value();

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
                        let recentGames = yield _(draftTeams).map(team => team.players).flatten().uniq().map(player => database.Game.findOne({'teams.composition.players.user': player.user}).sort({date: -1}).exec()).value();

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

                yield commitDraftChoice(choice);
            }
            catch (err) {
                self.postToLog({
                    description: `error in making automated choice: \`${JSON.stringify(turnDefinition)}\``,
                    error: err
                });

                self.sendMessage({
                    action: 'game draft aborted due to internal error'
                });

                yield self.cleanUpDraft();
            }
        });
    }

    function expireTime() {
        return co(function*() {
            let turnDefinition = DRAFT_ORDER[currentDraftTurn];

            if (turnDefinition.method === 'captain') {
                let captain = draftTeams[turnDefinition.team].captain;

                if (captain) {
                    currentDraftExpireCooldowns.add(captain);

                    yield self.updateUserRestrictions(captain);

                    setTimeout(removeDraftExpireCooldown, CAPTAIN_DRAFT_EXPIRE_COOLDOWN, captain);
                }
            }

            self.sendMessage({
                action: 'game draft aborted due to turn expiration'
            });

            yield self.cleanUpDraft();
        });
    }

    function beginDraftTurn(turn) {
        return co(function*() {
            currentDraftTurn = turn;

            unavailablePlayers = _(draftTeams).map(function(team) {
                return _(team.players).map(player => player.user).concat(team.captain).value();
            }).flatten().uniq().value();

            let turnDefinition = DRAFT_ORDER[turn];

            if (turnDefinition.type === 'playerPick' || turnDefinition.type === 'captainRole') {
                let team = draftTeams[turnDefinition.team].players;
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

            yield updateDraftStatusMessage();

            if (turnDefinition.method === 'captain') {
                if (!draftTeams[turnDefinition.team].captain) {
                    throw new Error('no captain to perform selection');
                }
            }
            else {
                yield makeAutomatedChoice();
            }
        });
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
            captainPool = _.filter(fullPlayerList, function(player) {
                let userRestrictions = self.getUserRestrictions(player);

                return !_.includes(userRestrictions.aspects, 'captain');
            });
        }

        remainingMaps = _.keys(MAP_POOL);

        draftTeams = [{
            faction: null,
            captain: null,
            players: []
        }, {
            faction: null,
            captain: null,
            players: []
        }];
        pickedMap = null;

        currentDraftGame = null;

        let legalState = checkIfLegalState(draftTeams, {
            picked: pickedMap,
            remaining: remainingMaps
        }, false);

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

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('draftStatusUpdated', yield getDraftStatusMessage());
    }));

    function onUserMakeDraftChoice(choice) {
        let userID = this.decoded_token.user;

        return co(function*() {
            choice.user = userID;

            yield commitDraftChoice(choice);
        });
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('makeDraftChoice');
        socket.on('makeDraftChoice', onUserMakeDraftChoice);
    });

    co(function*() {
        yield updateDraftStatusMessage();
    });
};
