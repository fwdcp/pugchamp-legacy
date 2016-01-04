/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var Chance = require('chance');
var config = require('config');
var lodash = require('lodash');
var ms = require('ms');

var chance = new Chance();

module.exports = function(app, io, self, server) {
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
    var draftOrder = config.get('app.draft.order');
    var turnTimeLimit = ms(config.get('app.draft.turnTimeLimit'));

    var playerPool;
    var fullPlayerList = [];
    var mapPool = config.get('app.games.maps');
    var draftCaptains = [];
    var currentDraftTurn = 0;
    var currentDraftTurnStartTime;
    var currentDraftTurnExpireTimeout = null;
    var draftChoices = [];

    var pickedTeams = [
        [],
        []
    ];
    var unavailablePlayers = [];
    var pickedMaps = [];
    var remainingMaps = [];
    var allowedRoles = null;
    var overrideRoles = null;

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

    function checkIfLegalState(teams, maps, final) {
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

        let mapsInSeries = config.get('app.games.mapsInSeries');

        if (lodash.size(maps.picked) + lodash.size(maps.remaining) < mapsInSeries) {
            return false;
        }

        if (final) {
            if (lodash.size(maps.picked) !== mapsInSeries) {
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
            roles: config.get('app.games.roles'),
            teamSize: config.get('app.games.teamSize'),
            draftTurns: lodash.map(draftOrder, function(turn, index) {
                let completeTurn = lodash.defaults({}, turn, draftChoices[index]);

                if (completeTurn.player) {
                    completeTurn.player = self.getFilteredUser(completeTurn.player);
                }

                return completeTurn;
            }),
            playerPool: lodash.mapValues(playerPool, function(rolePool) {
                return lodash.map(rolePool, function(userID) {
                    return self.getFilteredUser(userID);
                });
            }),
            fullPlayerList: lodash.map(fullPlayerList, function(userID) {
                return self.getFilteredUser(userID);
            }),
            mapPool: mapPool,
            draftCaptains: lodash.map(draftCaptains, function(userID) {
                return self.getFilteredUser(userID);
            }),
            currentDraftTurn: currentDraftTurn,
            pickedTeams: lodash.map(pickedTeams, function(team) {
                return lodash.map(team, function(player) {
                    let filteredPlayer = lodash.clone(player);

                    filteredPlayer.player = self.getFilteredUser(player.player);

                    return filteredPlayer;
                });
            }),
            unavailablePlayers: lodash.map(unavailablePlayers, function(userID) {
                return self.users[userID].steamID;
            }),
            pickedMaps: pickedMaps,
            remainingMaps: remainingMaps,
            allowedRoles: allowedRoles,
            overrideRoles: overrideRoles
        };

        return currentStatusMessage;
    }

    function expireTime() {
        // TODO: end the draft and clean everything up
    }

    function makeRandomChoice() {
        let turnDefinition = draftOrder[currentDraftTurn];

        let choice = {type: turnDefinition.type};

        if (turnDefinition.type === 'playerPick') {
            let team = pickedTeams[turnDefinition.captain - 1];
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
            let team = pickedTeams[turnDefinition.captain - 1];
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
            let team = pickedTeams[turnDefinition.captain - 1];
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
            allowedRoles = null;
            overrideRoles = null;
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

        if (turnDefinition.method === 'random') {
            makeRandomChoice();
        }
    }

    function completeDraft() {
        // TODO: complete draft
    }

    self.on('commitDraftChoice', function(choice) {
        if (!draftInProgress) {
            return;
        }

        let turnDefinition = draftOrder[currentDraftTurn];

        if (turnDefinition.method === 'captain' && choice.captain !== draftCaptains[turnDefinition.captain - 1]) {
            return;
        }
        else if (turnDefinition.method !== 'captain' && choice.captain) {
            return;
        }

        if (turnDefinition.type !== choice.type) {
            return;
        }

        let newTeams = lodash.cloneDeep(pickedTeams);
        let newPickedMaps = lodash.cloneDeep(pickedMaps);
        let newRemainingMaps = lodash.cloneDeep(remainingMaps);

        if (turnDefinition.type === 'playerPick') {
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

            newTeams[turnDefinition.captain - 1].push({
                player: choice.player,
                role: choice.role
            });
        }
        else if (turnDefinition.type === 'captainRole') {
            if (!lodash.includes(allowedRoles, choice.role)) {
                return;
            }

            newTeams[turnDefinition.captain - 1].push({
                player: draftCaptains[turnDefinition.captain - 1],
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

            newPickedMaps.push(choice.map);
            newRemainingMaps = lodash.without(remainingMaps, choice.map);
        }

        let isFinalTurn = currentDraftTurn + 1 === lodash.size(draftOrder);

        let legalNewState = checkIfLegalState(newTeams, {
            picked: newPickedMaps,
            remaining: newRemainingMaps
        }, isFinalTurn);

        if (!legalNewState) {
            throw new Error('Invalid state after valid choice!');
        }

        pickedTeams = newTeams;
        pickedMaps = newPickedMaps;
        remainingMaps = newRemainingMaps;

        draftChoices.push(choice);

        if (currentDraftTurnExpireTimeout) {
            clearTimeout(currentDraftTurnExpireTimeout);
        }

        if (isFinalTurn) {
            completeDraft();
        }
        else {
            beginDraftTurn(++currentDraftTurn);
        }
    });

    self.on('launchGameDraft', function(draftInfo) {
        draftInProgress = true;

        selectCaptains(draftInfo.captains);

        playerPool = draftInfo.players;
        fullPlayerList = lodash.reduce(playerPool, function(allPlayers, players) {
            return lodash.union(allPlayers, players);
        }, []);

        remainingMaps = lodash.keys(mapPool);

        pickedTeams = [
            [],
            []
        ];
        pickedMaps = [];

        let legalState = checkIfLegalState(pickedTeams, {
            picked: pickedMaps,
            remaining: remainingMaps
        }, false);

        if (!legalState) {
            throw new Error('Invalid state before draft start!');
        }

        beginDraftTurn(0);
    });

    io.sockets.on('connection', function(socket) {
        socket.emit('draftStatusUpdated', currentStatusMessage);

        if (draftInProgress) {
            socket.emit('draftTurnTime', {
                elapsed: Date.now() - currentDraftTurnStartTime,
                total: turnTimeLimit,
            });
        }
    });

    io.sockets.on('authenticated', function(socket) {
        socket.on('makeDraftChoice', function(choice) {
            choice.captain = socket.decoded_token;

            if (choice.player) {
                let user = lodash.find(fullPlayerList, function(player) {
                    return player.steamID === choice.player;
                });

                choice.player = user.id;
            }

            self.emit('commitDraftChoice', choice);
        });
    });
};
