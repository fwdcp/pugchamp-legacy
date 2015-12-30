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
        let currentRoleDistribution = calculateRoleDistribution(currentTeam);

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
    var draftCaptains = [];

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
                if (teamState.remaining > 0) {
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

        // TODO: check maps

        return true;
    }

    self.emit('launchGameDraft', function(draftInfo) {
        draftInProgress = true;

        selectCaptains(draftInfo.captains);

        // TODO: properly begin the drafting process
    });
};
