/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var chance = require('chance');
var config = require('config');
var lodash = require('lodash');
var ms = require('ms');

module.exports = function(app, io, self, server) {
    function calculateRoleDistribution(currentTeam) {
        return lodash.reduce(currentTeam, function(roles, player) {
            roles[player.role]++;
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

            if (currentRoleDistribution[roleName] > role.max) {
                current.overfilledRoles.push(roleName);
                current.overfilledTotal += currentRoleDistribution[roleName] - role.max;
            }
        }, {
            players: 0,
            underfilledRoles: [],
            underfilledTotal: 0,
            overfilledRoles: [],
            overfilledTotal: 0
        });

        currentState.remaining = config.get('app.games.teamSize') - currentState.players;
    }

    var draftInProgress = false;
    var draftOrder = config.get('app.draft.order');
    var turnTimeLimit = ms(config.get('app.launch.readyPeriod'));

    var playerPool;
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

    var currentStatusMessage = null;

    // TODO: provide internal method for retrieving current draft status

    function selectCaptains(captains) {
        let method = config.get('app.draft.captainSelectionWeight');

        let weights = [];

        if (method === 'equal') {
            lodash.forEach(captains, function() {
                weights.push(1);
            });
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

        if (teamsValid) {
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

        // TODO: properly fill the status message

        currentStatusMessage = {

        };

        return currentStatusMessage;
    }

    function expireTime() {
        // TODO: end the draft and clean everything up
    }

    function makeRandomChoice() {
        // TODO: pick something randomly
    }

    function beginDraftTurn(turn) {
        currentDraftTurn = turn;

        let turnDefinition = draftOrder[turn];

        if (turnDefinition.type === 'playerPick' || turnDefinition.type === 'captainRole') {
            let team = pickedTeams[turnDefinition.captain - 1];
            let teamState = calculateCurrentTeamState(team);

            if (teamState.remaining > teamState.underfilledTotal) {
                allowedRoles = lodash.difference(lodash.keys(), teamState.overfilledRoles);
            }
            else {
                allowedRoles = teamState.underfilledRoles;
            }

            unavailablePlayers = lodash(pickedTeams).flatten().map(function(pick) {
                return pick.userID;
            }).union(draftCaptains).uniq();
        }
        else {
            allowedRoles = null;
        }

        currentDraftTurnStartTime = Date.now();

        prepareStatusMessage();
        io.sockets.emit('draftStatusUpdated', currentStatusMessage);

        if (turnDefinition.method === 'random') {
            makeRandomChoice();
        }
        else if (turnDefinition.method === 'captain') {
            setTimeout(expireTime, turnTimeLimit);
        }
    }

    self.emit('launchGameDraft', function(draftInfo) {
        draftInProgress = true;

        selectCaptains(draftInfo.captains);

        playerPool = draftInfo.players;

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
};
