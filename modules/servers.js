/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const Chance = require('chance');
const co = require('co');
const config = require('config');
const crypto = require('crypto');
const lodash = require('lodash');
const ms = require('ms');
const RCON = require('srcds-rcon');

var chance = new Chance();

module.exports = function(app, database, io, self, server) {
    var gameServerPool = config.get('app.servers.pool');

    var commandTimeout = ms(config.get('app.servers.commandTimeout'));
    var mapChangeTimeout = ms(config.get('app.servers.mapChangeTimeout'));

    var maps = config.get('app.games.maps');
    var roles = config.get('app.games.roles');

    function connectToServer(gameServer) {
        return co(function*() {
            let gameServerInfo = gameServerPool[gameServer];

            let rcon = RCON({
                address: gameServerInfo.address,
                password: gameServerInfo.rcon
            });

            yield rcon.connect();

            return rcon;
        });
    }

    function sendCommandToServer(rcon, command, timeout) {
        return co(function*() {
            yield rcon.command(command, timeout ? timeout : commandTimeout);
        });
    }

    function getServerStatus(gameServer) {
        return co(function*() {
            try {
                let rcon = yield connectToServer(gameServer);

                let response = yield sendCommandToServer(rcon, 'pugchamp_game_info');

                let gameID = response.trim();

                if (gameID) {
                    try {
                        let game = yield database.Game.findById(gameID);

                        if (game) {
                            return {status: 'assigned', game: game};
                        }
                        else {
                            return {status: 'unknown'};
                        }
                    }
                    catch (err) {
                        return {status: 'unknown'};
                    }
                }
                else {
                    return {status: 'free'};
                }
            }
            catch (err) {
                return {status: 'unreachable'};
            }
        });
    }

    self.getServerStatuses = co.wrap(function* getServerStatuses() {
        let statuses = yield lodash.map(gameServerPool, gameServer => getServerStatus(gameServer));

        return lodash.zip(lodash.keys(gameServerPool), statuses);
    });

    self.getAvailableServers = co.wrap(function* getAvailableServers() {
        let statuses = yield self.getServerStatuses();

        return lodash(statuses).pickBy(function(status) {
            if (status.status === 'free') {
                return true;
            }

            if (status.status === 'assigned') {
                if (status.game.status === 'completed' || status.game.status === 'aborted') {
                    return true;
                }
            }

            return false;
        }).keys().value();
    });

    self.updateServerPlayers = co.wrap(function* updateServerPlayers(game) {
        let rcon = yield connectToServer(game.server);

        let populatedGame = yield game.populate('teams.composition.players.user').execPopulate();

        let players = lodash(populatedGame.teams).map(function(team) {
            return lodash.map(team.composition, function(role) {
                return lodash.map(role.players, function(player) {
                    return {
                        id: player.user.steamID,
                        alias: player.user.alias,
                        faction: team.faction,
                        class: roles[role.role].class,
                        replaced: player.replaced
                    };
                });
            });
        }).flattenDeep().compact().value();

        for (let player of players) {
            if (!player.replaced) {
                let gameTeam = 1;
                let gameClass = 0;

                if (player.faction === 'RED') {
                    gameTeam = 2;
                }
                else if (player.faction === 'BLU') {
                    gameTeam = 3;
                }

                if (player.class === 'scout') {
                    gameClass = 1;
                }
                else if (player.class === 'soldier') {
                    gameClass = 3;
                }
                else if (player.class === 'pyro') {
                    gameClass = 7;
                }
                else if (player.class === 'demoman') {
                    gameClass = 4;
                }
                else if (player.class === 'heavy') {
                    gameClass = 6;
                }
                else if (player.class === 'engineer') {
                    gameClass = 9;
                }
                else if (player.class === 'medic') {
                    gameClass = 5;
                }
                else if (player.class === 'sniper') {
                    gameClass = 2;
                }
                else if (player.class === 'spy') {
                    gameClass = 8;
                }

                yield sendCommandToServer(rcon, 'pugchamp_game_player_add "' + player.id + '" "' + player.alias + '" ' + gameTeam + ' ' + gameClass);
            }
            else {
                yield sendCommandToServer(rcon, 'pugchamp_game_player_remove "' + player.id + '"');
            }
        }
    });

    self.initializeServer = co.wrap(function* initializeServer(game) {
        let rcon = yield connectToServer(game.server);

        yield sendCommandToServer(rcon, 'pugchamp_game_reset');

        let gameServerInfo = gameServerPool[game.server];
        let hash = crypto.createHash('sha256');
        hash.update(game.id + '|' + gameServerInfo.salt);
        let key = hash.digest('hex');
        yield sendCommandToServer(rcon, 'pugchamp_server_url "' + config.get('server.baseURL') + '/api/servers/' + key + '"');

        yield sendCommandToServer(rcon, 'pugchamp_game_id "' + game.id + '"');

        let map = maps[game.map];
        yield sendCommandToServer(rcon, 'pugchamp_game_map "' + map.file + '"');
        yield sendCommandToServer(rcon, 'pugchamp_game_config "' + map.config + '"');

        yield self.updateServerPlayers(game);

        yield sendCommandToServer(rcon, 'pugchamp_game_start', mapChangeTimeout);
    });

    self.assignGameToServer = co.wrap(function* assignGameToServer(game) {
        let availableServers = yield self.getAvailableServers();

        game.server = chance.pick(availableServers);
        yield game.save();

        yield self.initializeServer(game);
    });

    app.get('/api/servers/:key', co.wrap(function*(req, res) {
        if (!req.query.game) {
            res.sendStatus(400);
            return;
        }

        let game = yield database.Game.findById(req.query.game);

        if (!game) {
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

        self.emit('receivedGameServerUpdate', req.query);

        res.sendStatus(200);
    }));
};
