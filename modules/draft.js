/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var chance = require('chance');
var config = require('config');
var lodash = require('lodash');

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
    var currentDraftTurn = 0;
    var draftCaptains = [];

    var pickedTeams = [
        [],
        []
    ];
    var pickedMaps = [];
    var remainingMaps = [];

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

    function beginDraftTurn(turn) {
        currentDraftTurn = 0;

        prepareStatusMessage();
        io.sockets.emit('draftStatusUpdated', currentStatusMessage);

        let turnDefinition = draftOrder[turn];

        let turnInfo = {};

        if (turnDefinition.type === 'playerPick') {
            // TODO: compile all of the roles that can be picked
            // TODO: compile all of the players that can't be picked
        }
        else if (turnDefinition.type === 'captainRole') {
            // TODO: compile all of the roles that can be picked
        }
        else if (turnDefinition.type === 'mapPick' || turnDefinition.type === 'mapBan') {
            // TODO: furnish
        }

        if (turnDefinition.method === 'random') {
            // TODO: hand off to method for random selection
        }
        else if (turnDefinition.method === 'captain') {
            // TODO: hand off to appropriate captain and set timer
        }
    }

    self.emit('launchGameDraft', function(draftInfo) {
        draftInProgress = true;

        selectCaptains(draftInfo.captains);

        pickedTeams = [
            [],
            []
        ];
        pickedMaps = [];
        remainingMaps = lodash.keys(config.get('app.games.maps'));

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
