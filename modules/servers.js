/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var Chance = require('chance');
var config = require('config');
var crypto = require('crypto');
var lodash = require('lodash');
var ms = require('ms');
var RCON = require('srcds-rcon');

var chance = new Chance();
var database = require('../database');

module.exports = function(app, io, self, server) {
    var gameServerPool = config.get('app.servers.pool');
    var serverTimeout = config.get('app.servers.timeout');

    var maps = config.get('app.games.maps');
    var roles = config.get('app.games.roles');

    function getAvailableServers() {
        return Promise.all(lodash.map(gameServerPool, function(gameServer, gameServerName) {
            let rcon = RCON({
                address: gameServer.address,
                password: gameServer.rcon
            });

            return Promise.race([
                rcon.connect().then(function() {
                    return rcon.command('pugchamp_game_info');
                }),
                new Promise(function(resolve, reject) {
                    setTimeout(reject, ms(serverTimeout), 'timed out');
                })
            ]).then(function(result) {
                let gameID = result.trim();

                if (gameID) {
                    return new Promise(function(resolve, reject) {
                        database.Game.findById(gameID, function(err, game) {
                            if (err) {
                                resolve(false);
                                return;
                            }

                            if (!game) {
                                resolve(gameServerName);
                                return;
                            }

                            if (game.status === 'completed' || game.status === 'aborted') {
                                resolve(gameServerName);
                            }
                            else {
                                resolve(false);
                            }
                        });
                    });
                }
                else {
                    return gameServerName;
                }
            }, function() {
                return false;
            });
        })).then(function(results) {
            return lodash.compact(results);
        });
    }
    var throttledGetAvailableServers = lodash.throttle(getAvailableServers, ms(config.get('app.servers.queryInterval')), {
        leading: true
    });

    self.on('getAvailableServers', function(callback) {
        throttledGetAvailableServers().then(function(results) {
            callback(results);
        });
    });

    function setUpServer(game, abortOnFail) {
        let gameServer = gameServerPool[game.server];

        let rcon = RCON({
            address: gameServer.address,
            password: gameServer.rcon
        });

        let map = maps[game.map];

        rcon.connect().then(function() {
            return rcon.command('pugchamp_game_reset');
        }).then(function() {
            let hash = crypto.createHash('sha256');

            hash.update(game.id + '|' + gameServer.salt);
            let key = hash.digest('hex');

            return rcon.command('pugchamp_server_url "' + config.get('server.baseURL') + '/api/servers/' + key + '"');
        }).then(function() {
            return rcon.command('pugchamp_game_id "' + game.id + '"');
        }).then(function() {
            return rcon.command('pugchamp_game_map "' + map.file + '"');
        }).then(function() {
            return rcon.command('pugchamp_game_config "' + map.config + '"');
        }).then(function() {
            return new Promise(function(resolve, reject) {
                game.populate('players.user', function(err, game) {
                    if (err) {
                        reject(err);
                        return;
                    }

                    Promise.all(lodash.map(game.players, function(player) {
                        let faction = game.captains[player.team].faction;
                        let role = roles[player.role];
                        let gameTeam = 1;
                        let gameClass = 0;

                        if (faction === 'RED') {
                            gameTeam = 2;
                        }
                        else if (faction === 'BLU') {
                            gameTeam = 3;
                        }

                        if (role.class === 'scout') {
                            gameClass = 1;
                        }
                        else if (role.class === 'soldier') {
                            gameClass = 3;
                        }
                        else if (role.class === 'pyro') {
                            gameClass = 7;
                        }
                        else if (role.class === 'demoman') {
                            gameClass = 4;
                        }
                        else if (role.class === 'heavy') {
                            gameClass = 6;
                        }
                        else if (role.class === 'engineer') {
                            gameClass = 9;
                        }
                        else if (role.class === 'medic') {
                            gameClass = 5;
                        }
                        else if (role.class === 'sniper') {
                            gameClass = 2;
                        }
                        else if (role.class === 'spy') {
                            gameClass = 8;
                        }

                        return rcon.command('pugchamp_game_player_add "' + player.user.steamID + '" "' + player.user.alias + '"' + gameTeam + ' ' + gameClass);
                    })).then(resolve, reject);
                });
            });
        }).then(function() {
            return rcon.command('pugchamp_game_start');
        }).catch(function() {
            if (!abortOnFail) {
                self.emit('sendSystemMessage', {
                    action: 'failed to set up server for drafted game, retrying soon'
                });

                setTimeout(setUpServer, ms(config.get('app.servers.retryInterval')), game, true);
            }
            else {
                self.emit('sendSystemMessage', {
                    action: 'failed to set up server for drafted game, aborting game'
                });

                game.status = 'aborted';
                game.save();

                self.emit('cleanUpDraft');
            }
        });
    }

    function retryGameLaunch(game) {
        self.emit('getAvailableServers', function(servers) {
            if (lodash.size(servers) === 0) {
                self.emit('sendSystemMessage', {
                    action: 'server not available for drafted game, aborting game'
                });

                game.status = 'aborted';
                game.save();

                self.emit('cleanUpDraft');

                return;
            }

            game.server = chance.pick(servers);
            game.save();

            setUpServer(game, false);
        });
    }

    self.on('launchGame', function(game) {
        self.emit('getAvailableServers', function(servers) {
            if (lodash.size(servers) === 0) {
                self.emit('sendSystemMessage', {
                    action: 'server not available for drafted game, retrying soon'
                });

                setTimeout(retryGameLaunch, ms(config.get('app.servers.retryInterval')), game);

                return;
            }

            game.server = chance.pick(servers);
            game.save();

            setUpServer(game, false);
        });
    });
};
