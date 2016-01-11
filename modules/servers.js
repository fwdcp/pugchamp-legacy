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
    var serverTimeout = ms(config.get('app.servers.timeout'));

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
                    return rcon.command('pugchamp_game_info', serverTimeout);
                }),
                new Promise(function(resolve, reject) {
                    setTimeout(reject, serverTimeout, 'timed out');
                })
            ]).then(function(result) {
                let gameID = result.trim();

                if (gameID) {
                    return database.Game.findById(gameID).exec().then(function(game) {
                        if (!game) {
                            return gameServerName;
                        }

                        if (game.status === 'completed' || game.status === 'aborted') {
                            return gameServerName;
                        }
                        else {
                            return false;
                        }
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

    self.on('abortGame', function(game) {
        // NOTE: force player update so players can add up immediately
        self.emit('retrieveUsers', lodash.map(game.players, function(player) {
            return player.user;
        }));

        self.emit('broadcastGameInfo', game);

        game.status = 'aborted';
        game.save();

        lodash.each(gameServerPool, function(gameServer) {
            let rcon = RCON({
                address: gameServer.address,
                password: gameServer.rcon
            });

            rcon.connect().then(function() {
                return rcon.command('pugchamp_game_info', serverTimeout);
            }).then(function(result) {
                let gameID = result.trim();

                if (gameID === game.id) {
                    return rcon.command('pugchamp_game_reset', serverTimeout);
                }
            });
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
            return rcon.command('pugchamp_game_reset', serverTimeout);
        }).then(function() {
            let hash = crypto.createHash('sha256');

            hash.update(game.id + '|' + gameServer.salt);
            let key = hash.digest('hex');

            return rcon.command('pugchamp_server_url "' + config.get('server.baseURL') + '/api/servers/' + key + '"', serverTimeout);
        }).then(function() {
            return rcon.command('pugchamp_game_id "' + game.id + '"', serverTimeout);
        }).then(function() {
            return rcon.command('pugchamp_game_map "' + map.file + '"', serverTimeout);
        }).then(function() {
            return rcon.command('pugchamp_game_config "' + map.config + '"', serverTimeout);
        }).then(function() {
            return game.populate('captains.user').execPopulate().then(function(game) {
                return lodash.reduce(game.captains, function(prev, captain) {
                    let cur;

                    if (captain.faction === 'RED') {
                        cur = rcon.command('mp_tournament_redteamname "' + captain.user.alias + '"', serverTimeout);
                    }
                    else if (captain.faction === 'BLU') {
                        cur = rcon.command('mp_tournament_blueteamname "' + captain.user.alias + '"', serverTimeout);
                    }

                    if (cur) {
                        if (prev) {
                            return prev.then(cur);
                        }
                        else {
                            return cur;
                        }
                    }
                    else {
                        return prev;
                    }
                }, null);
            });
        }).then(function() {
            return game.populate('players.user').execPopulate().then(function(game) {
                return lodash.reduce(game.players, function(prev, player) {
                    let cur;

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

                    cur = rcon.command('pugchamp_game_player_add "' + player.user.steamID + '" "' + player.user.alias + '" ' + gameTeam + ' ' + gameClass, serverTimeout);

                    if (cur) {
                        if (prev) {
                            return prev.then(cur);
                        }
                        else {
                            return cur;
                        }
                    }
                    else {
                        return prev;
                    }
                }, null);
            });
        }).then(function() {
            return rcon.command('pugchamp_game_start', serverTimeout);
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

                self.emit('abortGame', game);

                self.emit('cleanUpDraft');
            }
        });
    }

    function retryGameAssignment(game) {
        self.emit('getAvailableServers', function(servers) {
            if (lodash.size(servers) === 0) {
                self.emit('sendSystemMessage', {
                    action: 'server not available for drafted game, aborting game'
                });

                self.emit('abortGame', game);

                self.emit('cleanUpDraft');

                return;
            }

            game.server = chance.pick(servers);
            game.save();

            setUpServer(game, false);
        });
    }

    self.on('assignGameServer', function(game) {
        self.emit('getAvailableServers', function(servers) {
            if (lodash.size(servers) === 0) {
                self.emit('sendSystemMessage', {
                    action: 'server not available for drafted game, retrying soon'
                });

                setTimeout(retryGameAssignment, ms(config.get('app.servers.retryInterval')), game);

                return;
            }

            game.server = chance.pick(servers);
            game.save();

            setUpServer(game, false);
        });
    });

    app.get('/api/servers/:key', function(req, res) {
        if (!req.query.game) {
            res.sendStatus(400);
            return;
        }

        database.Game.findById(req.query.game, function(err, game) {
            if (err || !game) {
                res.sendStatus(404);
                return;
            }

            let gameServer = gameServerPool[game.server];

            let hash = crypto.createHash('sha256');
            hash.update(game.id + '|' + gameServer.salt);
            let key = hash.digest('hex');

            if (req.params.key !== key) {
                res.sendStatus(403);
                return;
            }

            if (req.query.status === 'setup') {
                if (game.status !== 'assigning') {
                    res.sendStatus(500);
                    throw new Error('game is not expected status');
                }

                self.emit('gameSetup', {
                    game: game
                });
            }
            else if (req.query.status === 'live') {
                if (game.status !== 'launching' && game.status !== 'live') {
                    res.sendStatus(500);
                    throw new Error('game is not expected status');
                }

                self.emit('gameLive', {
                    game: game,
                    score: req.query.score,
                    time: req.query.time
                });
            }
            else if (req.query.status === 'abandoned') {
                if (game.status !== 'live') {
                    res.sendStatus(500);
                    throw new Error('game is not expected status');
                }

                self.emit('gameAbandoned', {
                    game: game,
                    score: req.query.score,
                    duration: req.query.duration,
                    time: req.query.time
                });
            }
            else if (req.query.status === 'completed') {
                if (game.status !== 'live') {
                    res.sendStatus(500);
                    throw new Error('game is not expected status');
                }

                self.emit('gameCompleted', {
                    game: game,
                    score: req.query.score,
                    duration: req.query.duration,
                    time: req.query.time
                });
            }
            else if (req.query.status === 'logavailable') {
                self.emit('gameLogAvailable', {
                    game: game,
                    url: req.query.url
                });
            }

            res.sendStatus(200);
        });
    });
};
