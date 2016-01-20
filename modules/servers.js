/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const Chance = require('chance');
const co = require('co');
const config = require('config');
const crypto = require('crypto');
const ms = require('ms');
const RCON = require('srcds-rcon');

var chance = new Chance();

module.exports = function(app, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const COMMAND_TIMEOUT = ms(config.get('app.servers.commandTimeout'));
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const MAP_CHANGE_TIMEOUT = ms(config.get('app.servers.mapChangeTimeout'));
    const MAPS = config.get('app.games.maps');
    const ROLES = config.get('app.games.roles');

    function connectToRCON(gameServer) {
        return co(function*() {
            let gameServerInfo = GAME_SERVER_POOL[gameServer];

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
            let result = yield rcon.command(command, timeout ? timeout : COMMAND_TIMEOUT);

            return result;
        });
    }

    function getServerStatus(gameServer) {
        return co(function*() {
            try {
                let rcon = yield connectToRCON(gameServer);

                let response = yield sendCommandToServer(rcon, 'pugchamp_game_info');

                let gameID = _.trim(response);

                if (gameID) {
                    try {
                        let game = yield database.Game.findById(gameID);

                        if (game) {
                            return {
                                status: 'assigned',
                                game: game
                            };
                        }
                        else {
                            return {
                                status: 'unknown'
                            };
                        }
                    }
                    catch (err) {
                        return {
                            status: 'unknown'
                        };
                    }
                }
                else {
                    return {
                        status: 'free'
                    };
                }
            }
            catch (err) {
                return {
                    status: 'unreachable'
                };
            }
        });
    }

    self.getServerStatuses = co.wrap(function* getServerStatuses() {
        let statuses = yield _.map(GAME_SERVER_POOL, (gameServerInfo, gameServer) => getServerStatus(gameServer));

        return _.zipObject(_.keys(GAME_SERVER_POOL), statuses);
    });

    self.getAvailableServers = co.wrap(function* getAvailableServers() {
        let statuses = yield self.getServerStatuses();

        return _(statuses).pickBy(function(status) {
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

    self.sendRCONCommand = co.wrap(function* sendRCONCommand(server, command) {
        let rcon = yield connectToRCON(server);
        let result = yield sendCommandToServer(rcon, command);

        return result;
    });

    self.shutdownGame = co.wrap(function* shutdownGame(game) {
        let statuses = yield self.getServerStatuses();

        for (let server of _.keys(GAME_SERVER_POOL)) {
            let serverStatus = statuses[server];

            if (serverStatus.status === 'assigned' && self.getDocumentID(serverStatus.game) === self.getDocumentID(game)) {
                yield self.sendRCONCommand(server, 'pugchamp_game_reset');
            }
        }
    });

    self.updateServerPlayers = co.wrap(function* updateServerPlayers(game) {
        let serverStatus = yield getServerStatus(game.server);

        if (serverStatus.status !== 'assigned' || self.getDocumentID(serverStatus.game) !== self.getDocumentID(game)) {
            throw new Error('server not assigned to game');
        }

        let rcon = yield connectToRCON(game.server);

        let populatedGame = yield game.populate('teams.composition.players.user').execPopulate();

        let players = _(populatedGame.teams).map(function(team) {
            return _.map(team.composition, function(role) {
                return _.map(role.players, function(player) {
                    return {
                        id: player.user.steamID,
                        alias: player.user.alias,
                        faction: team.faction,
                        class: ROLES[role.role].class,
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
        game.status = 'assigning';
        yield game.save();

        let rcon = yield connectToRCON(game.server);

        yield sendCommandToServer(rcon, 'pugchamp_game_reset');

        let gameServerInfo = GAME_SERVER_POOL[game.server];
        let hash = crypto.createHash('sha256');
        hash.update(game.id + '|' + gameServerInfo.salt);
        let key = hash.digest('hex');
        yield sendCommandToServer(rcon, 'pugchamp_server_url "' + BASE_URL + '/api/servers/' + key + '"');

        yield sendCommandToServer(rcon, 'pugchamp_game_id "' + game.id + '"');

        let map = MAPS[game.map];
        yield sendCommandToServer(rcon, 'pugchamp_game_map "' + map.file + '"');
        yield sendCommandToServer(rcon, 'pugchamp_game_config "' + map.config + '"');

        yield self.updateServerPlayers(game);

        yield sendCommandToServer(rcon, 'pugchamp_game_start', MAP_CHANGE_TIMEOUT);
    });

    self.assignGameToServer = co.wrap(function* assignGameToServer(game, server) {
        game.status = 'assigning';
        yield game.save();

        if (!server) {
            let availableServers = yield self.getAvailableServers();

            if (_.size(availableServers) === 0) {
                throw new Error('no servers available');
            }

            server = chance.pick(availableServers);
        }

        game.server = server;
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

        let gameServer = GAME_SERVER_POOL[game.server];

        let hash = crypto.createHash('sha256');
        hash.update(game.id + '|' + gameServer.salt);
        let key = hash.digest('hex');

        if (req.params.key !== key) {
            res.sendStatus(403);
            return;
        }

        try {
            yield self.handleGameServerUpdate(req.query);

            res.sendStatus(200);
        }
        catch (err) {
            res.sendStatus(500);
        }
    }));
};
