/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const Chance = require('chance');
const config = require('config');
const lodash = require('lodash');
const ms = require('ms');

var chance = new Chance();

module.exports = function(app, database, io, self, server) {
    function calculateRoleDistribution(currentTeam) {
        return lodash.reduce(currentTeam, function(roles, player) {
            roles[player.role]++;

            return roles;
        }, lodash.mapValues(config.get('app.games.roles'), function() {
            return 0;
        }));
    }

    function calculateCurrentTeamState(team) {
        let currentRoleDistribution = calculateRoleDistribution(team);

        let currentState = lodash.reduce(config.get('app.games.roles'), function(current, role, roleName) {
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

        currentState.remaining = config.get('app.games.teamSize') - currentState.players;

        return currentState;
    }

    var draftInProgress = false;
    var draftComplete = false;
    var draftOrder = config.get('app.draft.order');
    var turnTimeLimit = ms(config.get('app.draft.turnTimeLimit'));

    var playerPool = lodash.mapValues(config.get('app.games.roles'), function() {
        return [];
    });
    var fullPlayerList = [];
    var mapPool = config.get('app.games.maps');
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

    var currentStatusMessage = null;

    self.on('checkIfDraftInProgress', function(callback) {
        callback(draftInProgress);
    });

    function selectCaptains(captains) {
        let method = config.get('app.draft.captainSelectionWeight');

        let weights = new Array(lodash.size(captains));

        if (method === 'equal') {
            lodash.fill(weights, 1, 0, lodash.size(captains));
        }

        let chosenCaptains = new Set();

        while (chosenCaptains.size < 2) {
            chosenCaptains.add(chance.weighted(captains, weights));
        }

        draftCaptains = lodash.take([...chosenCaptains], 2);

        return draftCaptains;
    }

    function checkIfLegalState(teams, maps, factions, final) {
        let teamsValid = lodash.every(teams, function(team) {
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

        if (!maps.picked && lodash.size(maps.remaining) === 0) {
            return false;
        }

        if (final) {
            if (!maps.picked) {
                return false;
            }

            if (lodash(factions).intersection(['RED', 'BLU']).size() !== 2) {
                return false;
            }

            if (factions[0] === factions[1]) {
                return false;
            }
        }

        return true;
    }

    function prepareStatusMessage() {
        if (!draftInProgress) {
            currentStatusMessage = null;
            return null;
        }

        currentStatusMessage = {
            draftComplete: draftComplete,
            roles: config.get('app.games.roles'),
            teamSize: config.get('app.games.teamSize'),
            draftTurns: lodash.map(draftOrder, function(turn, index) {
                let completeTurn = lodash.defaults({}, turn, draftChoices[index]);

                if (completeTurn.player) {
                    completeTurn.player = self.users.get(completeTurn.player).toObject();
                }

                return completeTurn;
            }),
            playerPool: lodash.mapValues(playerPool, function(rolePool) {
                return lodash.map(rolePool, function(userID) {
                    return self.users.get(userID).toObject();
                });
            }),
            fullPlayerList: lodash.map(fullPlayerList, function(userID) {
                return self.users.get(userID).toObject();
            }),
            mapPool: mapPool,
            draftCaptains: lodash.map(draftCaptains, function(userID) {
                return self.users.get(userID).toObject();
            }),
            currentDraftTurn: currentDraftTurn,
            teamFactions: teamFactions,
            pickedTeams: lodash.map(pickedTeams, function(team) {
                return lodash.map(team, function(player) {
                    let filteredPlayer = lodash.clone(player);

                    filteredPlayer.player = self.users.get(player.player).toObject();

                    return filteredPlayer;
                });
            }),
            unavailablePlayers: lodash.map(unavailablePlayers, function(userID) {
                return self.users.get(userID).steamID;
            }),
            pickedMap: pickedMap,
            remainingMaps: remainingMaps,
            allowedRoles: allowedRoles,
            overrideRoles: overrideRoles
        };

        return currentStatusMessage;
    }

    self.on('cleanUpDraft', function() {
        draftInProgress = false;
        draftComplete = false;

        playerPool = lodash.mapValues(config.get('app.games.roles'), function() {
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

        prepareStatusMessage();
        io.sockets.emit('draftStatusUpdated', currentStatusMessage);
    });

    function expireTime() {
        self.emit('sendSystemMessage', {
            action: 'game draft aborted due to turn expiration'
        });

        self.emit('cleanUpDraft');
    }

    function makeRandomChoice() {
        let turnDefinition = draftOrder[currentDraftTurn];

        let choice = {
            type: turnDefinition.type
        };

        if (turnDefinition.type === 'factionSelect') {
            choice.faction = chance.pick(['BLU', 'RED']);
        }
        else if (turnDefinition.type === 'playerPick') {
            let team = pickedTeams[turnDefinition.captain];
            let roleDistribution = calculateRoleDistribution(team);

            let roles = config.get('app.games.roles');

            let weights = lodash.map(allowedRoles, function(role) {
                let weight = 0.01;

                if (roleDistribution[role] < roles[role].min) {
                    weight += roles[role].min - roleDistribution[role];
                }

                weight /= lodash.size(playerPool[role]) + 0.01;

                return weight;
            });

            choice.role = chance.weighted(allowedRoles, weights);

            if (lodash.includes(overrideRoles, choice.role)) {
                choice.player = chance.pick(lodash.difference(fullPlayerList, unavailablePlayers));
            }
            else {
                choice.override = true;
                choice.player = chance.pick(lodash.difference(playerPool[choice.role], unavailablePlayers));
            }
        }
        else if (turnDefinition.type === 'captainRole') {
            let team = pickedTeams[turnDefinition.captain];
            let roleDistribution = calculateRoleDistribution(team);

            let roles = config.get('app.games.roles');

            let weights = lodash.map(allowedRoles, function(role) {
                let weight = 0.01;

                if (roleDistribution[role] < roles[role].min) {
                    weight += roles[role].min - roleDistribution[role];
                }

                weight /= lodash.size(playerPool[role]) + 0.01;

                return weight;
            });

            choice.role = chance.weighted(allowedRoles, weights);
        }
        else if (turnDefinition.type === 'mapBan' || turnDefinition.type === 'mapPick') {
            choice.type = turnDefinition.type;

            choice.map = chance.pick(remainingMaps);
        }

        self.emit('commitDraftChoice', choice);
    }

    function beginDraftTurn(turn) {
        currentDraftTurn = turn;

        let turnDefinition = draftOrder[turn];

        if (turnDefinition.type === 'playerPick' || turnDefinition.type === 'captainRole') {
            let team = pickedTeams[turnDefinition.captain];
            let teamState = calculateCurrentTeamState(team);

            if (teamState.remaining > teamState.underfilledTotal) {
                allowedRoles = lodash.difference(lodash.keys(config.get('app.games.roles')), teamState.filledRoles);
            }
            else {
                allowedRoles = teamState.underfilledRoles;
            }

            overrideRoles = lodash.filter(teamState.underfilledRoles, function(role) {
                return lodash(playerPool[role]).difference(unavailablePlayers).size() === 0;
            });
        }
        else {
            allowedRoles = [];
            overrideRoles = [];
        }

        unavailablePlayers = lodash(pickedTeams).flatten().map(function(pick) {
            return pick.player;
        }).union(draftCaptains).uniq().value();

        currentDraftTurnStartTime = Date.now();
        currentDraftTurnExpireTimeout = setTimeout(expireTime, turnTimeLimit);

        prepareStatusMessage();
        io.sockets.emit('draftStatusUpdated', currentStatusMessage);

        io.sockets.emit('draftTurnTime', {
            elapsed: Date.now() - currentDraftTurnStartTime,
            total: turnTimeLimit,
        });

        if (turnDefinition.method === 'captain') {
            self.emit('sendMessageToUser', {
                userID: draftCaptains[turnDefinition.captain],
                name: 'draftTurnChoice',
                arguments: []
            });
        }
        else if (turnDefinition.method === 'random') {
            makeRandomChoice();
        }
    }

    function completeDraft() {
        draftComplete = true;

        let legalNewState = checkIfLegalState(pickedTeams, {
            picked: pickedMap,
            remaining: remainingMaps
        }, teamFactions, true);

        if (!legalNewState) {
            throw new Error('Invalid state after draft completed!');
        }

        currentDraftTurn = lodash.size(draftOrder);

        allowedRoles = [];
        overrideRoles = [];

        unavailablePlayers = lodash(pickedTeams).flatten().map(function(pick) {
            return pick.player;
        }).union(draftCaptains).uniq().value();

        currentDraftTurnStartTime = Date.now();

        prepareStatusMessage();
        io.sockets.emit('draftStatusUpdated', currentStatusMessage);

        var game = new database.Game();
        game.status = 'assigning';
        game.date = Date.now();
        game.map = pickedMap;

        game.teams = lodash.map(pickedTeams, function(team, teamNumber) {
            return {
                captain: draftCaptains[teamNumber],
                faction: teamFactions[teamNumber],
                composition: lodash.map(team, function(player) {
                    return {
                        role: player.role,
                        players: [{
                            user: player.player
                        }]
                    };
                })
            };
        });

        game.draft.choices = lodash.map(draftChoices, function(choice, index) {
            return lodash.assign({}, choice, draftOrder[index]);
        });
        game.draft.pool.maps = lodash.keys(mapPool);
        game.draft.pool.players = lodash(playerPool).transform(function(pool, players, role) {
            lodash.each(players, function(player) {
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

        game.save(function(err) {
            if (err) {
                throw err;
            }

            self.emit('assignGameServer', game);
        });
    }

    self.on('commitDraftChoice', function(choice) {
        if (!draftInProgress || draftComplete) {
            return;
        }

        let turnDefinition = draftOrder[currentDraftTurn];

        if (turnDefinition.method === 'captain' && choice.captain !== draftCaptains[turnDefinition.captain]) {
            return;
        }
        else if (turnDefinition.method !== 'captain' && choice.captain) {
            return;
        }

        if (turnDefinition.type !== choice.type) {
            return;
        }

        let newFactions = lodash.cloneDeep(teamFactions);
        let newTeams = lodash.cloneDeep(pickedTeams);
        let newPickedMap = pickedMap;
        let newRemainingMaps = lodash.cloneDeep(remainingMaps);

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
            if (lodash.includes(unavailablePlayers, choice.player)) {
                return;
            }

            if (!lodash.includes(allowedRoles, choice.role)) {
                return;
            }

            if (choice.override) {
                if (!lodash.includes(overrideRoles, choice.role)) {
                    return;
                }
            }
            else {
                if (!lodash.includes(playerPool[choice.role], choice.player)) {
                    return;
                }
            }

            newTeams[turnDefinition.captain].push({
                player: choice.player,
                role: choice.role
            });
        }
        else if (turnDefinition.type === 'captainRole') {
            if (!lodash.includes(allowedRoles, choice.role)) {
                return;
            }

            newTeams[turnDefinition.captain].push({
                player: draftCaptains[turnDefinition.captain],
                role: choice.role
            });
        }
        else if (turnDefinition.type === 'mapBan') {
            if (!lodash.includes(remainingMaps, choice.map)) {
                return;
            }

            newRemainingMaps = lodash.without(remainingMaps, choice.map);
        }
        else if (turnDefinition.type === 'mapPick') {
            if (!lodash.includes(remainingMaps, choice.map)) {
                return;
            }

            newPickedMap = choice.map;
            newRemainingMaps = lodash.without(remainingMaps, choice.map);
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

        if (currentDraftTurn + 1 === lodash.size(draftOrder)) {
            completeDraft();
        }
        else {
            beginDraftTurn(++currentDraftTurn);
        }
    });

    self.on('launchGameDraft', function(draftInfo) {
        draftInProgress = true;
        draftComplete = false;

        io.sockets.emit('draftStarting');

        selectCaptains(draftInfo.captains);

        playerPool = draftInfo.players;
        fullPlayerList = lodash.reduce(playerPool, function(allPlayers, players) {
            return lodash.union(allPlayers, players);
        }, []);

        remainingMaps = lodash.keys(mapPool);

        teamFactions = [];
        pickedTeams = [
            [],
            []
        ];
        pickedMap = null;

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
        socket.emit('draftStatusUpdated', currentStatusMessage);

        if (draftInProgress && !draftComplete) {
            socket.emit('draftTurnTime', {
                elapsed: Date.now() - currentDraftTurnStartTime,
                total: turnTimeLimit,
            });
        }
    });

    io.sockets.on('authenticated', function(socket) {
        if (draftInProgress && !draftComplete && draftOrder[currentDraftTurn].method === 'captain' && socket.decoded_token === draftCaptains[draftOrder[currentDraftTurn].captain]) {
            socket.emit('draftTurnChoice');
        }

        socket.on('makeDraftChoice', function(choice) {
            choice.captain = socket.decoded_token;

            if (choice.player) {
                let user = lodash.find(fullPlayerList, function(player) {
                    return self.users.get(player).steamID === choice.player;
                });

                choice.player = user;
            }

            self.emit('commitDraftChoice', choice);
        });
    });
};
