'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const crypto = require('crypto');
const HttpStatus = require('http-status-codes');
const ms = require('ms');
const RCON = require('srcds-rcon');

module.exports = function(app, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const COMMAND_TIMEOUT = ms(config.get('app.servers.commandTimeout'));
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const MAP_CHANGE_TIMEOUT = ms(config.get('app.servers.mapChangeTimeout'));
    const MAPS = config.get('app.games.maps');
    const QUERY_INTERVAL = config.get('app.servers.queryInterval');
    const RETRY_ATTEMPTS = _.map(config.get('app.servers.retryAttempts'), delay => ms(delay));
    const ROLES = config.get('app.games.roles');
    const SERVER_TIMEOUT = ms(config.get('app.servers.serverTimeout'));

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

    function disconnectFromRCON(rcon) {
        return co(function*() {
            yield rcon.disconnect();
        });
    }

    function getServerStatus(gameServer) {
        return Promise.race([co(function*() {
            try {
                let rcon = yield connectToRCON(gameServer);

                try {
                    let response = yield sendCommandToServer(rcon, 'pugchamp_game_info');

                    let gameStatus = _.trim(response);

                    if (gameStatus === 'UNAVAILABLE') {
                        return {
                            status: 'unavailable'
                        };
                    }
                    else if (gameStatus === 'FREE') {
                        return {
                            status: 'free'
                        };
                    }
                    else {
                        try {
                            let game = yield database.Game.findById(gameStatus);

                            if (game) {
                                return {
                                    status: 'assigned',
                                    game
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
                }
                finally {
                    yield disconnectFromRCON(rcon);
                }
            }
            catch (err) {
                return {
                    status: 'unreachable'
                };
            }
        }), self.promiseDelay(SERVER_TIMEOUT, {
            status: 'unreachable'
        }, false)]);
    }

    self.getServerStatuses = co.wrap(function* getServerStatuses() {
        let statuses = yield _.map(GAME_SERVER_POOL, (gameServerInfo, gameServer) => getServerStatus(gameServer));

        return _.zipObject(_.keys(GAME_SERVER_POOL), statuses);
    });

    self.throttledGetServerStatuses = _.throttle(self.getServerStatuses, QUERY_INTERVAL);

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

    self.throttledGetAvailableServers = _.throttle(self.getAvailableServers, QUERY_INTERVAL);

    self.sendRCONCommand = co.wrap(function* sendRCONCommand(server, command) {
        let rcon = yield connectToRCON(server);

        try {
            let result = yield sendCommandToServer(rcon, command);

            return result;
        }
        finally {
            yield disconnectFromRCON(rcon);
        }
    });

    self.shutdownGame = co.wrap(function* shutdownGame(game) {
        yield _.map(GAME_SERVER_POOL, function(serverInfo, server) {
            return co(function*() {
                let serverStatus = yield getServerStatus(server);

                if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown') {
                    for (let delay of RETRY_ATTEMPTS) {
                        yield self.promiseDelay(delay, null, false);

                        serverStatus = yield getServerStatus(server);

                        if (serverStatus.status !== 'unreachable' && serverStatus.status !== 'unknown') {
                            break;
                        }
                    }
                }

                if (serverStatus.status === 'assigned' && self.getDocumentID(serverStatus.game) === self.getDocumentID(game)) {
                    yield self.sendRCONCommand(server, 'pugchamp_game_reset');
                }
            });
        });
    });

    self.updateServerPlayers = co.wrap(function* updateServerPlayers(game) {
        let serverStatus = yield getServerStatus(game.server);

        if (serverStatus.status !== 'assigned' || self.getDocumentID(serverStatus.game) !== self.getDocumentID(game)) {
            throw new Error('server not assigned to game');
        }

        let rcon = yield connectToRCON(game.server);

        try {
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

                    yield sendCommandToServer(rcon, `pugchamp_game_player_add "${player.id}" "${player.alias}" ${gameTeam} ${gameClass}`);
                }
                else {
                    yield sendCommandToServer(rcon, `pugchamp_game_player_remove "${player.id}"`);
                }
            }
        }
        finally {
            yield disconnectFromRCON(rcon);
        }
    });

    self.initializeServer = co.wrap(function* initializeServer(game) {
        if (!game.server) {
            throw new Error('no server is currently assigned to this game');
        }

        game.status = 'initializing';
        yield game.save();

        let rcon = yield connectToRCON(game.server);

        try {
            yield sendCommandToServer(rcon, 'pugchamp_game_reset');

            let gameServerInfo = GAME_SERVER_POOL[game.server];
            let hash = crypto.createHash('sha256');
            hash.update(`${game.id}|${gameServerInfo.salt}`);
            let key = hash.digest('hex');
            yield sendCommandToServer(rcon, `pugchamp_api_url "${BASE_URL}/api/servers/${key}"`);

            yield sendCommandToServer(rcon, `pugchamp_game_id "${game.id}"`);

            let map = MAPS[game.map];
            yield sendCommandToServer(rcon, `pugchamp_game_map "${map.file}"`);
            yield sendCommandToServer(rcon, `pugchamp_game_config "${map.config}"`);

            yield self.updateServerPlayers(game);

            try {
                yield sendCommandToServer(rcon, 'pugchamp_game_start', MAP_CHANGE_TIMEOUT);
            }
            catch (err) {
                let serverStatus = yield getServerStatus(game.server);

                if (serverStatus.status !== 'assigned' || self.getDocumentID(serverStatus.game) !== self.getDocumentID(game) || serverStatus.game.status === 'initializing') {
                    throw err;
                }
            }
        }
        finally {
            yield disconnectFromRCON(rcon);
        }
    });

    self.assignGameToServer = co.wrap(function* assignGameToServer(game, server) {
        game.status = 'initializing';
        yield game.save();

        if (!server) {
            let availableServers = yield self.getAvailableServers();

            if (_.size(availableServers) === 0) {
                for (let delay of RETRY_ATTEMPTS) {
                    yield self.promiseDelay(delay, null, false);

                    availableServers = yield self.getAvailableServers();

                    if (_.size(availableServers) !== 0) {
                        break;
                    }
                }

                if (_.size(availableServers) === 0) {
                    throw new Error('no servers available');
                }
            }

            server = chance.pick(availableServers);
        }

        game.server = server;
        yield game.save();

        try {
            yield self.initializeServer(game);
        }
        catch (err) {
            self.postToLog({
                description: `encountered error while trying to initialize server \`${server}\` for game \`${game.id}\``,
                error: err
            });

            let success = false;

            for (let delay of RETRY_ATTEMPTS) {
                yield self.promiseDelay(delay, null, false);

                try {
                    yield self.initializeServer(game);

                    success = true;
                    break;
                }
                catch (err) {
                    self.postToLog({
                        description: `encountered error while trying to initialize server \`${server}\` for game \`${game.id}\``,
                        error: err
                    });

                    success = false;
                    continue;
                }
            }

            if (!success) {
                throw new Error('failed to initialize server');
            }
        }
    });

    app.get('/servers', co.wrap(function*(req, res) {
        let servers;

        if (req.user && req.user.admin) {
            servers = yield self.getServerStatuses();
        }
        else {
            servers = yield self.throttledGetServerStatuses();
        }

        res.render('servers', {
            servers: _(servers).mapValues((status, name) => _(status).assign(GAME_SERVER_POOL[name]).omit('rcon', 'salt').value()).value()
        });
    }));

    app.get('/api/servers/:key', co.wrap(function*(req, res) {
        if (!req.query.game) {
            res.sendStatus(HttpStatus.BAD_REQUEST);
            return;
        }

        let game = yield database.Game.findById(req.query.game);

        if (!game) {
            res.sendStatus(HttpStatus.NOT_FOUND);
            return;
        }

        let gameServer = GAME_SERVER_POOL[game.server];

        let hash = crypto.createHash('sha256');
        hash.update(`${game.id}|${gameServer.salt}`);
        let key = hash.digest('hex');

        if (req.params.key !== key) {
            res.sendStatus(HttpStatus.FORBIDDEN);
            return;
        }

        try {
            yield self.handleGameServerUpdate(req.query);

            res.sendStatus(HttpStatus.OK);
        }
        catch (err) {
            res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }));
};
