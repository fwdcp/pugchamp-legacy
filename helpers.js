'use strict';

const _ = require('lodash');
const child_process = require('child_process');
const path = require('path');

const helpers = {
    getDocumentID(info) {
        if (_.hasIn(info, 'toHexString')) {
            return info.toHexString();
        }

        if (_.isString(info)) {
            return info;
        }

        if (_.isObject(info)) {
            if (_.hasIn(info, '_id') && _.hasIn(info._id, 'toHexString')) {
                return info._id.toHexString();
            }

            if (_.hasIn(info, 'id')) {
                return info.id;
            }
        }

        return null;
    },
    getGameUsers(game) {
        let users = [];

        for (let team of game.teams) {
            users.push(team.captain);

            for (let role of team.composition) {
                for (let player of role.players) {
                    users.push(player.user);
                }
            }
        }

        return _.uniqBy(users, user => helpers.getDocumentID(user));
    },
    getGameUserInfo(game, user) {
        let userID = helpers.getDocumentID(user);

        let team;
        let role;
        let player;

        team = _.find(game.teams, function(currentTeam) {
            role = _.find(currentTeam.composition, function(currentRole) {
                player = _.find(currentRole.players, function(currentPlayer) {
                    return userID === helpers.getDocumentID(currentPlayer.user);
                });

                if (player) {
                    return true;
                }

                return false;
            });

            if (role || userID === helpers.getDocumentID(currentTeam.captain)) {
                return true;
            }

            return false;
        });

        if (team) {
            return {
                game,
                team,
                role,
                player
            };
        }

        return null;
    },
    promiseDelay(delay, value = undefined, fail = false) {
        return new Promise(function(resolve, reject) {
            if (!fail) {
                setTimeout(resolve, delay, value);
            }
            else {
                setTimeout(reject, delay, value);
            }
        });
    },
    runAppScript(scriptName, args = []) {
        return helpers.runScript(path.join('scripts', `${scriptName}.js`), args, {
            cwd: process.cwd()
        });
    },
    runScript(script, args = [], options = {}) {
        return new Promise(function(resolve, reject) {
            let child = child_process.fork(script, args, options);

            child.on('error', function(err) {
                reject(err);
            });

            child.on('exit', function(code, signal) {
                if (code || signal) {
                    reject(code || signal);
                }
                else {
                    resolve();
                }
            });
        });
    }
};

module.exports = helpers;
