'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const crypto = require('crypto');
const debug = require('debug')('pugchamp:servers');
const Gamedig = require('gamedig');
const HttpStatus = require('http-status-codes');
const ms = require('ms');
const RateLimiter = require('limiter').RateLimiter;
const RCON = require('srcds-rcon');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const COMMAND_TIMEOUT = ms(config.get('app.servers.commandTimeout'));
    const CONNECT_TIMEOUT = ms(config.get('app.servers.connectTimeout'));
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const MAP_CHANGE_TIMEOUT = ms(config.get('app.servers.mapChangeTimeout'));
    const MAPS = config.get('app.games.maps');
    const MAXIMUM_SERVER_COMMAND_LENGTH = 511;
    const RECHECK_INTERVAL = ms(config.get('app.servers.recheckInterval'));
    const RECONNECT_INTERVAL = ms(config.get('app.servers.reconnectInterval'));
    const RETRY_ATTEMPTS = _.map(config.get('app.servers.retryAttempts'), delay => ms(delay));
    const ROLES = config.get('app.games.roles');
    const SIMPLE_RETRY_INTERVALS = _.map(config.get('app.servers.simpleRetryIntervals'), delay => ms(delay));

    var rconConnections = new Map();
    var rconConnectionLimits = new Map();

    /**
     * @async
     */
    function queryServer(server) {
        return new Promise(function(resolve, reject) {
            Gamedig.query(server, function(state) {
                if (!state.error) {
                    resolve(state);
                }
                else {
                    reject(new Error(state.error));
                }
            });
        });
    }

    /**
     * @async
     */
    function connectToRCON(server) {
        return co(function*() {
            let serverInfo = GAME_SERVER_POOL[server];

            let rcon = RCON(serverInfo.rcon);

            yield Promise.race([rcon.connect(), helpers.promiseDelay(CONNECT_TIMEOUT, new Error('connection attempt timed out'), true)]);

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
    function establishRCONConnection(server) {
        return co(function*() {
            let limiter = rconConnectionLimits.get(server);

            if (limiter.tryRemoveTokens(1)) {
                try {
                    if (rconConnections.has(server)) {
                        debug(`found existing connection to ${server}, disconnecting`);

                        let rcon = rconConnections.get(server);

                        yield disconnectFromRCON(rcon);

                        rconConnections.delete(server);
                    }

                    debug(`connecting to ${server}`);
                    let rcon = yield connectToRCON(server);

                    debug(`connection to ${server} succeeded`);
                    rconConnections.set(server, rcon);
                }
                catch (err) {
                    debug(`connection to ${server} failed: ${err.stack}`);

                    debug(`retrying connection to ${server} in ${RECONNECT_INTERVAL}ms`);
                    setTimeout(establishRCONConnection, RECONNECT_INTERVAL, server);

                    throw new Error('failed to connect to RCON');
                }
            }
            else {
                debug(`hit rate limit for connecting to ${server}`);
                throw new Error('RCON connection attempts on cooldown');
            }
        });
    }

    /**
     * @async
     */
    self.updateServerStatus = co.wrap(function* updateServerStatus(server) {
        let serverStatus;

        try {
            let serverInfo = yield queryServer(_.merge({
                type: 'tf2'
            }, GAME_SERVER_POOL[server].query));

            if (_.has(serverInfo, 'raw.rules.pugchamp_game_info')) {
                let gameStatus = _.get(serverInfo, 'raw.rules.pugchamp_game_info');

                if (gameStatus === 'UNAVAILABLE') {
                    serverStatus = {
                        status: 'unavailable'
                    };
                }
                else if (gameStatus === 'FREE') {
                    serverStatus = {
                        status: 'free'
                    };
                }
                else {
                    try {
                        let game = yield database.Game.findById(gameStatus);

                        if (game) {
                            serverStatus = {
                                status: 'assigned',
                                game: game.toObject()
                            };
                        }
                        else {
                            serverStatus = {
                                status: 'unknown'
                            };
                        }
                    }
                    catch (err) {
                        serverStatus = {
                            status: 'unknown'
                        };
                    }
                }
            }
            else {
                serverStatus = {
                    status: 'unknown'
                };
            }
        }
        catch (err) {
            serverStatus = {
                status: 'unreachable'
            };
        }

        debug(`status for ${server} is now ${serverStatus.status}`);
        yield cache.setAsync(`serverStatus-${server}`, JSON.stringify(serverStatus));

        self.emit('serversUpdated');
    });

    self.updateServerStatuses = co.wrap(function* updateServerStatuses() {
        yield _.map(_.keys(GAME_SERVER_POOL), server => self.updateServerStatus(server));
    });

    /**
     * @async
     */
    self.getServerStatus = co.wrap(function* getServerStatus(server) {
        if (!(yield cache.existsAsync(`serverStatus-${server}`))) {
            yield self.updateServerStatus(server);
        }

        return JSON.parse(yield cache.getAsync(`serverStatus-${server}`));
    });

    /**
     * @async
     */
    self.getServerStatuses = co.wrap(function* getServerStatuses() {
        return _.zipObject(_.keys(GAME_SERVER_POOL), yield _.map(_.keys(GAME_SERVER_POOL), server => self.getServerStatus(server)));
    });

    /**
     * @async
     */
    self.findAvailableServer = co.wrap(function* findAvailableServer() {
        let serverStatuses = yield self.getServerStatuses();

        // update supposedly free servers first
        let freeServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'free');
        yield _.map(freeServers, server => self.updateServerStatus(server));
        serverStatuses = yield self.getServerStatuses();
        freeServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'free');

        // if servers are confirmed free, use them
        if (_.size(freeServers) > 0) {
            return chance.pick(freeServers);
        }

        // update all unassigned servers next
        let unassignedServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status !== 'assigned');
        yield _.map(unassignedServers, server => self.updateServerStatus(server));
        serverStatuses = yield self.getServerStatuses();
        freeServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'free');

        // if servers are confirmed free, use them
        if (_.size(freeServers) > 0) {
            return chance.pick(freeServers);
        }

        // finally look for servers that are assigned but not needed
        let assignedServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'assigned');
        yield _.map(assignedServers, server => self.updateServerStatus(server));
        yield _.map(assignedServers, co.wrap(function*(server) {
            let updatedGame = yield database.Game.findById(helpers.getDocumentID(serverStatuses[server].game));

            if (updatedGame.status === 'aborted' || updatedGame.status === 'completed') {
                // force immediate reset
                yield self.shutdownGame(updatedGame, true);
                yield self.updateServerStatus(server);
            }
        }));
        serverStatuses = yield self.getServerStatuses();
        freeServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'free');

        // if servers are confirmed free, use them
        if (_.size(freeServers) > 0) {
            return chance.pick(freeServers);
        }

        // no servers actually available
        return null;
    });

    /**
     * @async
     */
    self.sendRCONCommands = co.wrap(function* sendRCONCommands(server, commands, retry, timeout) {
        let success = false;

        try {
            if (!rconConnections.has(server)) {
                debug(`not currently connected to ${server}`);
                establishRCONConnection(server);

                throw new Error('not currently connected to RCON');
            }

            let rcon = rconConnections.get(server);

            debug(`sending ${commands} to ${server}`);
            let result = yield sendCommandsToServer(rcon, commands, timeout);

            debug(`received result of commands from ${server}`);
            return result;
        }
        catch (err) {
            debug(`failed to send commands to ${server}: ${err.stack}`);

            if (retry) {
                for (let delay of SIMPLE_RETRY_INTERVALS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield helpers.promiseDelay(delay, null, false);

                    try {
                        yield self.sendRCONCommands(server, commands, false, timeout);

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
            establishRCONConnection(server);

            throw new Error('sending commands to server failed');
        }
    });

    /**
     * @async
     */
    self.resetServer = co.wrap(function* resetServer(server, retry) {
        let success = false;

        try {
            yield self.sendRCONCommands(server, ['pugchamp_game_reset'], true);
            yield self.updateServerStatus(server);

            let serverStatus = yield self.getServerStatus(server);

            if (serverStatus.status !== 'free' && serverStatus.status !== 'unavailable') {
                throw new Error('server reset failed');
            }

            success = true;
        }
        catch (err) {
            debug(`error while resetting server ${server}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield helpers.promiseDelay(delay, null, false);

                    try {
                        yield self.resetServer(server, false);

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
            throw new Error('failed to reset server');
        }
    });

    /**
     * @async
     */
    self.shutdownGame = co.wrap(function* shutdownGame(game, retry) {
        debug(`shutting down servers for game ${game.id}`);
        let serverStatuses = yield self.getServerStatuses();

        yield _.map(serverStatuses, co.wrap(function*(serverStatus, server) {
            if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown') {
                if (retry) {
                    for (let delay of SIMPLE_RETRY_INTERVALS) {
                        debug(`waiting for ${delay}ms before retrying`);
                        yield helpers.promiseDelay(delay, null, false);

                        try {
                            yield self.updateServerStatus(server);
                            serverStatus = yield self.getServerStatus(server);

                            if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown') {
                                throw new Error('server status still unknown');
                            }

                            break;
                        }
                        catch (err) {
                            continue;
                        }
                    }
                }
            }

            if (serverStatus.status === 'assigned' && helpers.getDocumentID(serverStatus.game) === helpers.getDocumentID(game)) {
                // update server just to make sure
                yield self.updateServerStatus(server);
                serverStatus = yield self.getServerStatus(server);

                if (serverStatus.status === 'assigned' && helpers.getDocumentID(serverStatus.game) === helpers.getDocumentID(game)) {
                    yield self.resetServer(server, true);
                }
            }
        }));
    });

    /**
     * @async
     */
    self.updateServerPlayers = co.wrap(function* updateServerPlayers(game, retry) {
        let success = false;

        try {
            let serverStatus = yield self.getServerStatus(game.server);

            if (serverStatus.status !== 'assigned' || helpers.getDocumentID(serverStatus.game) !== helpers.getDocumentID(game)) {
                debug(`server ${game.server} is not assigned to game ${game.id}`);
                throw new Error('server not assigned to game');
            }

            let gameUsers = yield self.getCachedUsers(helpers.getGameUsers(game));
            let commands = _.map(gameUsers, function(user) {
                let gameUserInfo = helpers.getGameUserInfo(game, user);

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
            yield self.sendRCONCommands(game.server, commands, true);

            success = true;
        }
        catch (err) {
            debug(`encountered error while trying to update server players to game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield helpers.promiseDelay(delay, null, false);

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
            yield self.shutdownGame(game, true);

            let serverInfo = GAME_SERVER_POOL[game.server];
            let hash = crypto.createHash('sha256');
            hash.update(`${helpers.getDocumentID(game)}|${serverInfo.salt}`);
            let key = hash.digest('hex');

            let mapInfo = MAPS[game.map];

            debug(`resetting server ${game.server} for game ${game.id}`);
            yield self.resetServer(game.server, false);

            debug(`performing initial setup for server ${game.server} for game ${game.id}`);
            yield self.sendRCONCommands(game.server, [`pugchamp_api_url "${BASE_URL}/api/servers/${key}"`, `pugchamp_game_id "${helpers.getDocumentID(game)}"`, `pugchamp_game_map "${mapInfo.file}"`, `pugchamp_game_config "${mapInfo.config}"`], true);

            yield self.updateServerStatus(game.server);
            yield self.updateServerPlayers(game, false);

            try {
                debug(`launching server ${game.server} for game ${game.id}`);
                yield self.sendRCONCommands(game.server, ['pugchamp_game_start'], true, MAP_CHANGE_TIMEOUT);
            }
            catch (err) {
                yield self.updateServerStatus(game.server);
                let serverStatus = yield self.getServerStatus(game.server);

                if (serverStatus.status !== 'assigned' || helpers.getDocumentID(serverStatus.game) !== helpers.getDocumentID(game) || serverStatus.game.status === 'initializing') {
                    debug(`game server ${game.server} not launched for game ${game.id}`);
                    throw err;
                }
            }

            success = true;
        }
        catch (err) {
            debug(`encountered error while trying to initialize server for game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield helpers.promiseDelay(delay, null, false);

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

                let server = yield self.findAvailableServer();

                if (!server) {
                    debug('failed to find available server');
                    throw new Error('no servers available');
                }

                game.server = server;
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
            debug(`encountered error while trying to assign server for game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    yield helpers.promiseDelay(delay, null, false);

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
        let servers = yield self.getServerStatuses();

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

        let serverInfo = GAME_SERVER_POOL[game.server];

        let hash = crypto.createHash('sha256');
        hash.update(`${helpers.getDocumentID(game)}|${serverInfo.salt}`);
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
            debug(`failed to handle update for game ${helpers.getDocumentID(game)} (${JSON.stringify(req.query)}): ${err.stack}`);

            let success = false;

            for (let delay of RETRY_ATTEMPTS) {
                yield helpers.promiseDelay(delay, null, false);

                try {
                    yield self.handleGameServerUpdate(req.query);

                    success = true;
                    break;
                }
                catch (err) {
                    debug(`failed to handle update for game ${helpers.getDocumentID(game)} (${JSON.stringify(req.query)}): ${err.stack}`);

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

        yield self.updateServerStatus(game.server);
    }));

    co(function*() {
        yield self.updateServerStatuses();

        for (let server of _.keys(GAME_SERVER_POOL)) {
            rconConnectionLimits.set(server, new RateLimiter(1, RECONNECT_INTERVAL));
            establishRCONConnection(server);
        }

        setInterval(co.wrap(function*() {
            yield self.updateServerStatuses();
            let serverStatuses = yield self.getServerStatuses();

            yield _.map(serverStatuses, co.wrap(function*(serverStatus, server) {
                if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown' || serverStatus.status === 'unavailable') {
                    self.postToLog({
                        description: `server \`${server}\` is currently ${serverStatus.status}`
                    });
                }
                else if (serverStatus.status === 'assigned') {
                    let updatedGame = yield database.Game.findById(helpers.getDocumentID(serverStatus.game));

                    if (updatedGame.status !== 'launching' && updatedGame.status !== 'live') {
                        self.postToLog({
                            description: `server \`${server}\` is currently assigned to game \`${helpers.getDocumentID(serverStatus.game)}\` which is ${updatedGame.status}`
                        });
                    }
                }
            }));
        }), RECHECK_INTERVAL);
    });
};
