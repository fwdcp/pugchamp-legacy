'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const crypto = require('crypto');
const debug = require('debug')('pugchamp:servers');
const HttpStatus = require('http-status-codes');
const ms = require('ms');
const RateLimiter = require('limiter').RateLimiter;
const RCON = require('srcds-rcon');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const COMMAND_TIMEOUT = ms(config.get('app.servers.commandTimeout'));
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const MAP_CHANGE_TIMEOUT = ms(config.get('app.servers.mapChangeTimeout'));
    const MAPS = config.get('app.games.maps');
    const MAXIMUM_SERVER_COMMAND_LENGTH = 511;
    const QUERY_INTERVAL = config.get('app.servers.queryInterval');
    const RETRY_ATTEMPTS = _.map(config.get('app.servers.retryAttempts'), delay => ms(delay));
    const ROLES = config.get('app.games.roles');
    const SERVER_TIMEOUT = ms(config.get('app.servers.serverTimeout'));

    /**
     * @async
     */
    function connectToRCON(gameServer) {
        return co(function*() {
            let gameServerInfo = GAME_SERVER_POOL[gameServer];

            let rcon = RCON(gameServerInfo.rcon);

            yield rcon.connect();

            return rcon;
        });
    }

    /**
     * @async
     */
    function sendCommandsToServer(rcon, commands, timeout) {
        return co(function*() {
            let condensedCommands = [];

            let partialCondensedCommand = '';
            for (let command of commands) {
                if (_.size(partialCondensedCommand) + _.size(command) > MAXIMUM_SERVER_COMMAND_LENGTH) {
                    condensedCommands.push(partialCondensedCommand);
                    partialCondensedCommand = command;
                }
                else {
                    partialCondensedCommand = `${partialCondensedCommand};${command}`;
                }
            }
            if (_.size(partialCondensedCommand) > 0) {
                condensedCommands.push(_.trim(partialCondensedCommand, ';'));
            }

            let results = [];

            for (let condensedCommand of condensedCommands) {
                let result = yield rcon.command(condensedCommand, !_.isUndefined(timeout) ? timeout : COMMAND_TIMEOUT);

                results.push(result);
            }

            return _.join(results, '\n');
        });
    }

    /**
     * @async
     */
    function disconnectFromRCON(rcon) {
        return co(function*() {
            yield rcon.disconnect();
        });
    }

    /**
     * @async
     */
    function getServerStatus(gameServer) {
        return Promise.race([co(function*() {
            try {
                let rcon = yield connectToRCON(gameServer);

                try {
                    let response = yield sendCommandsToServer(rcon, ['pugchamp_game_info']);

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

    var serverUpdateLimiter = new RateLimiter(1, QUERY_INTERVAL);

    /**
     * @async
     */
    self.updateServerStatuses = co.wrap(function* updateServerStatuses() {
        let serverStatuses = _.zipObject(_.keys(GAME_SERVER_POOL), yield _.map(_.keys(GAME_SERVER_POOL), gameServer => getServerStatus(gameServer)));
        _.forEach(serverStatuses, function(status) {
            if (status.game) {
                status.game = status.game.toObject();
            }
        });

        yield cache.setAsync('serverStatuses', JSON.stringify(serverStatuses));

        self.emit('serversUpdated');
    });

    /**
     * @async
     */
    self.getServerStatuses = co.wrap(function* getServerStatuses(forceUpdate) {
        if (serverUpdateLimiter.tryRemoveTokens(1) || forceUpdate) {
            yield self.updateServerStatuses();
        }

        let cacheResponse = yield cache.getAsync('serverStatuses');

        if (!cacheResponse) {
            yield self.updateServerStatuses();
            cacheResponse = yield cache.getAsync('serverStatuses');
        }

        return JSON.parse(cacheResponse);
    });

    /**
     * @async
     */
    self.getAvailableServers = co.wrap(function* getAvailableServers(forceUpdate) {
        let statuses = yield self.getServerStatuses(forceUpdate);

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

    /**
     * @async
     */
    self.sendRCONCommands = co.wrap(function* sendRCONCommands(server, commands) {
        let rcon;

        try {
            rcon = yield connectToRCON(server);

            let result = yield sendCommandsToServer(rcon, commands);

            return result;
        }
        finally {
            if (rcon) {
                yield disconnectFromRCON(rcon);
            }
        }
    });

    /**
     * @async
     */
    self.shutdownGame = co.wrap(function* shutdownGame(game) {
        debug(`shutting down servers for game ${game.id}`);
        yield _.map(GAME_SERVER_POOL, co.wrap(function*(serverInfo, server) {
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
                debug(`found server ${server} assigned to game ${game.id}, shutting down`);
                yield self.sendRCONCommands(server, ['pugchamp_game_reset']);
            }
        }));

        yield self.updateServerStatuses();
    });

    /**
     * @async
     */
    self.updateServerPlayers = co.wrap(function* updateServerPlayers(game, retry) {
        let success = false;

        try {
            let serverStatus = yield getServerStatus(game.server);

            if (serverStatus.status !== 'assigned' || self.getDocumentID(serverStatus.game) !== self.getDocumentID(game)) {
                debug(`server ${game.server} is not assigned to game ${game.id}`);
                throw new Error('server not assigned to game');
            }

            let gameUsers = yield _.map(self.getGameUsers(game), user => self.getCachedUser(user));
            let commands = _.map(gameUsers, function(user) {
                let gameUserInfo = self.getGameUserInfo(game, user);

                if (gameUserInfo.player) {
                    if (!gameUserInfo.player.replaced) {
                        let className = ROLES[gameUserInfo.role.role].class;

                        let gameTeam = 1;
                        let gameClass = 0;

                        if (gameUserInfo.team.faction === 'RED') {
                            gameTeam = 2;
                        }
                        else if (gameUserInfo.team.faction === 'BLU') {
                            gameTeam = 3;
                        }

                        if (className === 'scout') {
                            gameClass = 1;
                        }
                        else if (className === 'soldier') {
                            gameClass = 3;
                        }
                        else if (className === 'pyro') {
                            gameClass = 7;
                        }
                        else if (className === 'demoman') {
                            gameClass = 4;
                        }
                        else if (className === 'heavy') {
                            gameClass = 6;
                        }
                        else if (className === 'engineer') {
                            gameClass = 9;
                        }
                        else if (className === 'medic') {
                            gameClass = 5;
                        }
                        else if (className === 'sniper') {
                            gameClass = 2;
                        }
                        else if (className === 'spy') {
                            gameClass = 8;
                        }

                        return `pugchamp_game_player_add "${user.steamID}" "${user.alias}" ${gameTeam} ${gameClass}`;
                    }
                    else {
                        return `pugchamp_game_player_remove "${user.steamID}"`;
                    }
                }
                else {
                    let gameTeam = 1;

                    if (gameUserInfo.team.faction === 'RED') {
                        gameTeam = 2;
                    }
                    else if (gameUserInfo.team.faction === 'BLU') {
                        gameTeam = 3;
                    }

                    return `pugchamp_game_player_add "${user.steamID}" "${user.alias}" ${gameTeam} 0`;
                }
            });

            debug(`sending commands to update players on server ${game.server} for game ${game.id}`);
            yield self.sendRCONCommands(game.server, commands);

            success = true;
        }
        catch (err) {
            self.postToLog({
                description: `encountered error while trying to update server players to game \`${self.getDocumentID(game)}\``,
                error: err
            });

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield self.promiseDelay(delay, null, false);

                    try {
                        yield self.updateServerPlayers(game, false);

                        success = true;
                        break;
                    }
                    catch (err) {
                        success = false;
                        continue;
                    }
                }
            }
        }

        if (!success) {
            throw new Error('failed to update server players');
        }
    });

    /**
     * @async
     */
    self.initializeServer = co.wrap(function* initializeServer(game, retry) {
        if (!game.server) {
            throw new Error('no server is currently assigned to this game');
        }

        let success = false;

        try {
            debug(`initializing server ${game.server} for game ${game.id}`);

            debug(`resetting status of game ${game.id} to initializing`);
            game.status = 'initializing';
            yield game.save();

            debug(`updating game ${game.id}`);
            yield self.processGameUpdate(game);

            debug(`resetting servers currently assigned to game ${game.id}`);
            yield self.shutdownGame(game);

            let gameServerInfo = GAME_SERVER_POOL[game.server];
            let hash = crypto.createHash('sha256');
            hash.update(`${self.getDocumentID(game)}|${gameServerInfo.salt}`);
            let key = hash.digest('hex');

            let mapInfo = MAPS[game.map];

            let rcon;

            try {
                debug(`connecting to RCON for server ${game.server} for game ${game.id}`);
                rcon = yield connectToRCON(game.server);

                debug(`resetting server ${game.server} for game ${game.id}`);
                yield sendCommandsToServer(rcon, ['pugchamp_game_reset']);

                debug(`performing initial setup for server ${game.server} for game ${game.id}`);
                yield sendCommandsToServer(rcon, [`pugchamp_api_url "${BASE_URL}/api/servers/${key}"`, `pugchamp_game_id "${self.getDocumentID(game)}"`, `pugchamp_game_map "${mapInfo.file}"`, `pugchamp_game_config "${mapInfo.config}"`]);

                yield self.updateServerPlayers(game, false);

                try {
                    debug(`launching server ${game.server} for game ${game.id}`);
                    yield sendCommandsToServer(rcon, ['pugchamp_game_start'], MAP_CHANGE_TIMEOUT);
                }
                catch (err) {
                    let serverStatus = yield getServerStatus(game.server);

                    if (serverStatus.status !== 'assigned' || self.getDocumentID(serverStatus.game) !== self.getDocumentID(game) || serverStatus.game.status === 'initializing') {
                        debug(`game server ${game.server} not launched for game ${game.id}`);
                        throw err;
                    }
                }
            }
            finally {
                if (rcon) {
                    debug(`disconnecting from RCON for server ${game.server} for game ${game.id}`);
                    yield disconnectFromRCON(rcon);
                }
            }

            yield self.updateServerStatuses();

            success = true;
        }
        catch (err) {
            self.postToLog({
                description: `encountered error while trying to initialize server for game \`${self.getDocumentID(game)}\``,
                error: err
            });

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield self.promiseDelay(delay, null, false);

                    try {
                        yield self.initializeServer(game, false);

                        success = true;
                        break;
                    }
                    catch (err) {
                        success = false;
                        continue;
                    }
                }
            }
        }

        if (!success) {
            throw new Error('failed to initialize server');
        }
    });

    /**
     * @async
     */
    self.assignGameToServer = co.wrap(function* assignGameToServer(game, retry, requestedServer) {
        let success = false;

        try {
            debug(`assigning game ${game.id} to server`);

            debug(`resetting status of game ${game.id} to initializing`);
            game.status = 'initializing';
            game.server = null;
            yield game.save();

            debug(`updating game ${game.id}`);
            yield self.processGameUpdate(game);

            if (!requestedServer) {
                debug(`randomly assigning game ${game.id} to available server`);
                let availableServers = yield self.getAvailableServers(true);

                if (_.size(availableServers) === 0) {
                    debug('failed to find servers');
                    throw new Error('no servers available');
                }

                game.server = chance.pick(availableServers);
            }
            else {
                game.server = requestedServer;
            }

            debug(`assigning game ${game.id} to server ${game.server}`);
            yield game.save();

            debug(`updating game ${game.id}`);
            yield self.processGameUpdate(game);

            yield self.initializeServer(game, false);

            success = true;
        }
        catch (err) {
            self.postToLog({
                description: `encountered error while trying to assign server to game \`${self.getDocumentID(game)}\``,
                error: err
            });

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield self.promiseDelay(delay, null, false);

                    try {
                        yield self.assignGameToServer(game, false, requestedServer);

                        success = true;
                        break;
                    }
                    catch (err) {
                        success = false;
                        continue;
                    }
                }
            }
        }

        if (!success) {
            throw new Error('failed to assign game to server');
        }
    });

    app.get('/servers', co.wrap(function*(req, res) {
        let servers = yield self.getServerStatuses(self.isUserAdmin(req.user));

        res.render('servers', {
            servers: _.mapValues(servers, (status, name) => ({
                server: _.omit(GAME_SERVER_POOL[name], 'rcon', 'salt'),
                status
            }))
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
        hash.update(`${self.getDocumentID(game)}|${gameServer.salt}`);
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
            self.postToLog({
                description: `failed to handle game update: \`${JSON.stringify(req.query)}\``,
                error: err
            });

            let success = false;

            for (let delay of RETRY_ATTEMPTS) {
                yield self.promiseDelay(delay, null, false);

                try {
                    yield self.handleGameServerUpdate(req.query);

                    success = true;
                    break;
                }
                catch (err) {
                    self.postToLog({
                        description: `failed to handle game update: \`${JSON.stringify(req.query)}\``,
                        error: err
                    });

                    success = false;
                    continue;
                }
            }

            if (success) {
                res.sendStatus(HttpStatus.OK);
            }
            else {
                res.sendStatus(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        }

        yield self.updateServerStatuses();
    }));
};
