'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const ms = require('ms');

const helpers = require('../helpers');

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
        }, _.mapValues(ROLES, _.constant(0)));
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

    /**
     * @async
     */
    function updateDraftStatusMessage() {
        return co(function*() {
            let draftStatusMessage = {
                active: draftActive,
                complete: draftComplete,
                currentDraftTurn,
                roles: ROLES,
                teamSize: TEAM_SIZE,
                unavailablePlayers,
                mapPool: MAP_POOL,
                pickedMap,
                remainingMaps,
                allowedRoles,
                overrideRoles
            };

            if (draftActive && !draftComplete) {
                draftStatusMessage.turnStartTime = currentDraftTurnStartTime;
                draftStatusMessage.turnEndTime = currentDraftTurnStartTime + TURN_TIME_LIMIT;
            }

            draftStatusMessage.captainPool = yield _.map(captainPool, user => self.getCachedUser(user));

            draftStatusMessage.fullPlayerList = yield _.map(fullPlayerList, user => self.getCachedUser(user));

            draftStatusMessage.playerPool = {};
            for (let role of _.keys(ROLES)) {
                draftStatusMessage.playerPool[role] = _.map(playerPool[role], player => _.find(draftStatusMessage.fullPlayerList, user => (helpers.getDocumentID(player) === helpers.getDocumentID(user))));
            }

            draftStatusMessage.draftTurns = _.map(DRAFT_ORDER, (turn, index) => _.merge({}, turn, draftChoices[index]));
            for (let turn of draftStatusMessage.draftTurns) {
                if (turn.player) {
                    turn.player = _.find(draftStatusMessage.fullPlayerList, user => (helpers.getDocumentID(turn.player) === helpers.getDocumentID(user)));
                }

                if (turn.captain) {
                    turn.captain = _.find(draftStatusMessage.captainPool, user => (helpers.getDocumentID(turn.captain) === helpers.getDocumentID(user)));
                }
            }

            draftStatusMessage.draftTeams = _.cloneDeep(draftTeams);
            for (let team of draftStatusMessage.draftTeams) {
                if (team.captain) {
                    team.captain = _.find(draftStatusMessage.captainPool, user => (helpers.getDocumentID(team.captain) === helpers.getDocumentID(user)));
                }

                for (let player of team.players) {
                    player.user = _.find(draftStatusMessage.fullPlayerList, user => (helpers.getDocumentID(player.user) === helpers.getDocumentID(user)));
                }
            }

            yield cache.setAsync('draftStatus', JSON.stringify(draftStatusMessage));

            io.sockets.emit('draftStatusUpdated', draftStatusMessage);
        });
    }

    /**
     * @async
     */
    function getDraftStatusMessage() {
        return co(function*() {
            if (!(yield cache.existsAsync('draftStatus'))) {
                yield updateDraftStatusMessage();
            }

            return JSON.parse(yield cache.getAsync('draftStatus'));
        });
    }

    /**
     * @async
     */
    function updateDraftUsers() {
        return co(function*() {
            let draftUsers = (draftActive && !draftComplete) ? _.union(captainPool, fullPlayerList) : [];

            yield cache.setAsync('draftUsers', JSON.stringify(draftUsers));
        });
    }

    /**
     * @async
     */
    self.processDraftStatusUpdate = _.debounce(co.wrap(function* processDraftStatusUpdate() {
        yield updateDraftUsers();

        yield updateDraftStatusMessage();
    }));

    /**
     * @async
     */
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

        self.processDraftStatusUpdate();

        // NOTE: hacks with previous draft info - clear draft restrictions and mark activity to prevent players from getting removed
        yield self.updateUserRestrictions(_.union(previousDraftPlayers, previousDraftPlayers));
        for (let user of _.union(previousDraftCaptains, previousDraftPlayers)) {
            self.markUserActivity(user);
        }

        self.emit('draftStatusChanged', draftActive);
    });

    /**
     * @async
     */
    function launchGameFromDraft() {
        return co(function*() {
            let game = new database.Game();
            game.status = 'initializing';
            game.date = new Date();
            game.map = pickedMap;

            game.teams = _.map(draftTeams, team => ({
                captain: team.captain,
                faction: team.faction,
                composition: _.map(team.players, player => ({
                    role: player.role,
                    players: [{
                        user: player.user
                    }]
                }))
            }));

            game.draft.choices = _.map(draftChoices, (choice, index) => _.assign({}, choice, DRAFT_ORDER[index]));
            game.draft.pool.maps = _.keys(MAP_POOL);
            game.draft.pool.players = _(playerPool).transform(function(pool, players, role) {
                _.forEach(players, function(player) {
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

            let usersToUpdate = _.unionBy(captainPool, fullPlayerList, user => helpers.getDocumentID(user));

            try {
                yield game.save();

                yield self.processGameUpdate(game);

                yield updateDraftUsers();
                yield self.updateUserRestrictions(_.union(captainPool, fullPlayerList));

                currentDraftGame = helpers.getDocumentID(game);

                yield self.assignGameToServer(game, true);
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

            yield self.updatePlayerStats(usersToUpdate);
        });
    }

    /**
     * @async
     */
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

            unavailablePlayers = _(draftTeams).flatMap(team => _(team.players).map('user').concat(team.captain).value()).uniq().value();

            currentDraftTurnStartTime = Date.now();

            self.processDraftStatusUpdate();

            yield launchGameFromDraft();
        });
    }

    /**
     * @async
     */
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
                    if (_.some(unavailablePlayers, choice.captain) && !_.some(draftTeams[turnDefinition.team].players, ['user', choice.captain])) {
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

    /**
     * @async
     */
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
                        turnCaptainPool = _(draftTeams[turnDefinition.team].players).map('user').intersection(captainPool).value();
                    }

                    if (_.size(turnCaptainPool) === 0) {
                        throw new Error('no potential captains to select from');
                    }

                    if (turnDefinition.method === 'random') {
                        choice.captain = chance.pick(turnCaptainPool);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'success') {
                        /* eslint-disable lodash/prefer-lodash-method */
                        let fullCaptains = yield database.User.find({
                            '_id': {
                                $in: turnCaptainPool
                            }
                        }).exec();
                        /* eslint-enable lodash/prefer-lodash-method */

                        let candidates = _.map(fullCaptains, captain => helpers.getDocumentID(captain));
                        let weights = _.map(fullCaptains, captain => (_.isNumber(captain.stats.captainScore.center) ? captain.stats.captainScore.center : 0));

                        let boost = EPSILON;
                        let minWeight = _.min(weights);
                        if (minWeight <= 0) {
                            boost += -1 * minWeight;
                        }

                        weights = _.map(weights, weight => weight + boost);

                        choice.captain = chance.weighted(candidates, weights);

                        supported = true;
                    }
                    else if (turnDefinition.method === 'success-random') {
                        /* eslint-disable lodash/prefer-lodash-method */
                        let fullCaptains = yield database.User.find({
                            '_id': {
                                $in: turnCaptainPool
                            }
                        }).exec();
                        /* eslint-enable lodash/prefer-lodash-method */

                        let candidates = _.map(fullCaptains, captain => helpers.getDocumentID(captain));
                        let weights = _.map(fullCaptains, captain => (_.isNumber(captain.stats.captainScore.center) ? captain.stats.captainScore.center : 0));

                        let boost = EPSILON;
                        let minWeight = _.min(weights);
                        if (minWeight <= 0) {
                            boost += -1 * minWeight;
                        }

                        weights = _.map(weights, weight => weight + boost);

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
                        /* eslint-disable lodash/prefer-lodash-method */
                        let fullCaptains = yield database.User.find({
                            '_id': {
                                $in: turnCaptainPool
                            }
                        }).exec();
                        /* eslint-enable lodash/prefer-lodash-method */

                        let mostExperienced = _.maxBy(fullCaptains, 'stats.total.player');
                        choice.captain = helpers.getDocumentID(mostExperienced);

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

                        /* eslint-disable lodash/prefer-lodash-method */
                        let choicePool = yield database.User.find({
                            '_id': {
                                $in: choice.override ? _.difference(fullPlayerList, unavailablePlayers) : _.difference(playerPool[choice.role], unavailablePlayers)
                            }
                        }).exec();
                        /* eslint-enable lodash/prefer-lodash-method */

                        if (_.size(choicePool) === 0) {
                            throw new Error('no players to choose from');
                        }

                        let desiredRating = 1500;

                        let allyTeam = turnDefinition.team === 0 ? 0 : 1;
                        let enemyTeam = turnDefinition.team === 0 ? 1 : 0;
                        if (_.size(draftTeams[allyTeam].players) < _.size(draftTeams[enemyTeam].players)) {
                            /* eslint-disable lodash/prefer-lodash-method */
                            let allyPlayers = yield database.User.find({
                                '_id': {
                                    $in: _.map(draftTeams[allyTeam].players, 'user')
                                }
                            }).exec();
                            /* eslint-enable lodash/prefer-lodash-method */

                            let allyTotalRating = _.sumBy(allyPlayers, 'stats.rating.mean');

                            /* eslint-disable lodash/prefer-lodash-method */
                            let enemyPlayers = yield database.User.find({
                                '_id': {
                                    $in: _.map(draftTeams[enemyTeam].players, 'user')
                                }
                            }).exec();
                            /* eslint-enable lodash/prefer-lodash-method */

                            let enemyTotalRating = _.sumBy(enemyPlayers, 'stats.rating.mean');

                            desiredRating = enemyTotalRating - allyTotalRating;
                        }
                        else {
                            desiredRating = _.sumBy(choicePool, 'stats.rating.mean') / _.size(choicePool);
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
                        let recentGames = yield _(draftTeams).flatMap('players').uniq().map(player => database.Game.findOne({
                            'teams.composition.players.user': player.user
                        }).sort({
                            date: -1
                        }).exec()).value();

                        let recentlyPlayedMap = _.chain(recentGames).reduce(function(maps, game) {
                            if (!game || !_.includes(remainingMaps, game.map)) {
                                return maps;
                            }

                            if (!maps[game.map]) {
                                maps[game.map] = 0;
                            }

                            maps[game.map]++;

                            return maps;
                        }, {}).toPairs().maxBy('1').value();

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
                        let recentGames = yield _(draftTeams).flatMap('players').uniq().map(player => database.Game.findOne({
                            'teams.composition.players.user': player.user
                        }).sort({
                            date: -1
                        }).exec()).value();

                        let recentlyPlayedMap = _.chain(recentGames).reduce(function(maps, game) {
                            if (!game || !_.includes(remainingMaps, game.map)) {
                                return maps;
                            }

                            if (!maps[game.map]) {
                                maps[game.map] = 0;
                            }

                            maps[game.map]++;

                            return maps;
                        }, {}).toPairs().minBy('1').value();

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

    /**
     * @async
     */
    function expireTime() {
        return co(function*() {
            let turnDefinition = DRAFT_ORDER[currentDraftTurn];

            if (turnDefinition.method === 'captain') {
                let captain = draftTeams[turnDefinition.team].captain;

                if (captain) {
                    yield cache.setAsync('draftExpired-${captain}', JSON.stringify(true), 'PX', CAPTAIN_DRAFT_EXPIRE_COOLDOWN);

                    yield self.updateUserRestrictions([captain]);
                }
            }

            self.sendMessage({
                action: 'game draft aborted due to turn expiration'
            });

            yield self.cleanUpDraft();
        });
    }

    /**
     * @async
     */
    function beginDraftTurn(turn) {
        return co(function*() {
            currentDraftTurn = turn;

            unavailablePlayers = _(draftTeams).flatMap(team => _(team.players).map('user').concat(team.captain).value()).flatten().uniq().value();

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

            self.processDraftStatusUpdate();

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

    self.launchDraft = co.wrap(function* launchDraft(draftInfo) {
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
            let userRestrictions = _.zipObject(fullPlayerList, yield _.map(fullPlayerList, user => self.getUserRestrictions(user)));

            captainPool = _.reject(fullPlayerList, player => _.includes(userRestrictions[player].aspects, 'captain'));
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

        yield updateDraftUsers();
        yield self.updateUserRestrictions(_.union(captainPool, fullPlayerList));

        self.processDraftStatusUpdate();

        self.emit('draftStatusChanged', draftActive);

        beginDraftTurn(0);
    });

    io.sockets.on('connection', co.wrap(function*(socket) {
        socket.emit('draftStatusUpdated', yield getDraftStatusMessage());
    }));

    function onUserMakeDraftChoice(choice) {
        let userID = this.decoded_token.user;

        co(function*() {
            choice.user = userID;

            yield commitDraftChoice(choice);
        });
    }

    io.sockets.on('authenticated', function(socket) {
        socket.removeAllListeners('makeDraftChoice');
        socket.on('makeDraftChoice', onUserMakeDraftChoice);
    });

    self.processDraftStatusUpdate();
};
