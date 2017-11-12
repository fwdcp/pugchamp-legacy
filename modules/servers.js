'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const config = require('config');
const crypto = require('crypto');
const debug = require('debug')('pugchamp:servers');
const Gamedig = require('gamedig');
const HttpStatus = require('http-status-codes');
const ms = require('ms');
const RateLimiter = require('limiter').RateLimiter;
const Rcon = require('modern-rcon');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const BASE_URL = config.get('server.baseURL');
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const MAPS = config.get('app.games.maps');
    const MAXIMUM_SERVER_COMMAND_LENGTH = 511;
    const RCON_TIMEOUT = ms(config.get('app.servers.rconTimeout'));
    const RECHECK_INTERVAL = ms(config.get('app.servers.recheckInterval'));
    const RECONNECT_INTERVAL = ms(config.get('app.servers.reconnectInterval'));
    const RETRY_ATTEMPTS = _.map(config.get('app.servers.retryAttempts'), delay => ms(delay));
    const ROLES = config.get('app.games.roles');
    const SIMPLE_RETRY_INTERVALS = _.map(config.get('app.servers.simpleRetryIntervals'), delay => ms(delay));

    var rconConnections = new Map();
    var rconConnectionLimits = new Map();

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

    function setupRCON(server) {
        let serverInfo = GAME_SERVER_POOL[server];

        let rcon = new Rcon(serverInfo.rcon.host, serverInfo.rcon.port, serverInfo.rcon.password, RCON_TIMEOUT);

        rconConnections.set(server, rcon);
    }

    async function connectToRCON(rcon) {
        await rcon.connect();
    }

    async function sendCommandsToServer(rcon, commands) {
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
            let result = await rcon.send(condensedCommand);

            results.push(result);
        }

        return _.join(results, '\n');
    }

    async function disconnectFromRCON(rcon) {
        await rcon.disconnect();
    }

    async function establishRCONConnection(server) {
        let limiter = rconConnectionLimits.get(server);

        if (limiter.tryRemoveTokens(1)) {
            let rcon = rconConnections.get(server);

            try {
                debug(`attempting to disconnect existing connection to ${server}`);

                await disconnectFromRCON(rcon);
            }
            catch (err) {
                // ignore
            }

            try {
                debug(`connecting to ${server}`);
                await connectToRCON(rcon);
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
    }

    self.updateServerStatus = async function updateServerStatus(server) {
        let serverStatus;

        try {
            let serverInfo = await queryServer(_.merge({
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
                        let game = await database.Game.findById(gameStatus);

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
        await cache.setAsync(`serverStatus-${server}`, JSON.stringify(serverStatus));

        self.emit('serversUpdated');
    };

    self.updateServerStatuses = async function updateServerStatuses() {
        await Promise.all(_.map(_.keys(GAME_SERVER_POOL), server => self.updateServerStatus(server)));
    };

    self.getServerStatus = async function getServerStatus(server) {
        if (!(await cache.existsAsync(`serverStatus-${server}`))) {
            await self.updateServerStatus(server);
        }

        return JSON.parse(await cache.getAsync(`serverStatus-${server}`));
    };

    self.getServerStatuses = async function getServerStatuses() {
        return _.zipObject(_.keys(GAME_SERVER_POOL), await Promise.all(_.map(_.keys(GAME_SERVER_POOL), server => self.getServerStatus(server))));
    };

    self.findAvailableServer = async function findAvailableServer() {
        // update all server statuses
        await self.updateServerStatuses();

        // free up assigned unneeded servers first
        await Promise.all(_.map(await self.getServerStatuses(), async function(serverStatus, server) {
            if (serverStatus.status === 'assigned' && (!serverStatus.game || serverStatus.game.status === 'aborted' || serverStatus.game.status === 'completed')) {
                // force immediate reset
                await self.shutdownGameServers(serverStatus.game);
            }

            // update again just to be sure
            await self.updateServerStatus(server);
        }));

        // get server statuses and find servers that are free
        let serverStatuses = await self.getServerStatuses();
        let freeServers = _.filter(_.keys(serverStatuses), server => serverStatuses[server].status === 'free');

        // if servers are confirmed free, use them
        if (_.size(freeServers) > 0) {
            return chance.pick(freeServers);
        }

        // no servers actually available
        return null;
    };

    self.sendRCONCommands = async function sendRCONCommands(server, commands, retry = true) {
        let success = false;

        let result;

        try {
            let rcon = rconConnections.get(server);

            debug(`sending ${commands} to ${server}`);
            result = await sendCommandsToServer(rcon, commands);

            debug(`received result of commands from ${server}`);

            success = true;
        }
        catch (err) {
            debug(`failed to send commands to ${server}: ${err.stack}`);

            if (retry) {
                for (let delay of SIMPLE_RETRY_INTERVALS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    await helpers.promiseDelay(delay);

                    try {
                        result = await self.sendRCONCommands(server, commands, false);

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

        return result;
    };

    self.resetServer = async function resetServer(server, retry = true) {
        let success = false;

        try {
            await self.sendRCONCommands(server, ['pugchamp_game_reset']);
            await self.updateServerStatus(server);

            let serverStatus = await self.getServerStatus(server);

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
                    await helpers.promiseDelay(delay);

                    try {
                        await self.resetServer(server, false);

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
    };

    self.shutdownGameServers = async function shutdownGameServers(game, retry = true) {
        debug(`shutting down servers for game ${game.id}`);
        let serverStatuses = await self.getServerStatuses();

        await Promise.all(_.map(serverStatuses, async function(serverStatus, server) {
            if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown') {
                if (retry) {
                    for (let delay of SIMPLE_RETRY_INTERVALS) {
                        debug(`waiting for ${delay}ms before retrying`);
                        await helpers.promiseDelay(delay);

                        try {
                            await self.updateServerStatus(server);
                            serverStatus = await self.getServerStatus(server);

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
                await self.updateServerStatus(server);
                serverStatus = await self.getServerStatus(server);

                if (serverStatus.status === 'assigned' && helpers.getDocumentID(serverStatus.game) === helpers.getDocumentID(game)) {
                    await self.resetServer(server);
                }
            }
        }));
    };

    self.updateServerPlayers = async function updateServerPlayers(game, retry = true) {
        let success = false;

        try {
            let serverStatus = await self.getServerStatus(game.server);

            if (serverStatus.status !== 'assigned' || helpers.getDocumentID(serverStatus.game) !== helpers.getDocumentID(game)) {
                debug(`server ${game.server} is not assigned to game ${game.id}`);
                throw new Error('server not assigned to game');
            }

            let gameUsers = await self.getCachedUsers(helpers.getGameUsers(game));
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
            await self.sendRCONCommands(game.server, commands);

            success = true;
        }
        catch (err) {
            debug(`encountered error while trying to update server players to game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    await helpers.promiseDelay(delay);

                    try {
                        await self.updateServerPlayers(game, false);

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
    };

    self.initializeServer = async function initializeServer(game, retry = true) {
        if (!game.server) {
            throw new Error('no server is currently assigned to this game');
        }

        let success = false;

        try {
            debug(`initializing server ${game.server} for game ${game.id}`);

            debug(`resetting status of game ${game.id} to initializing`);
            game.status = 'initializing';
            await game.save();

            debug(`updating game ${game.id}`);
            await self.processGameUpdate(game);

            debug(`resetting servers currently assigned to game ${game.id}`);
            await self.shutdownGameServers(game);

            let serverInfo = GAME_SERVER_POOL[game.server];
            let hash = crypto.createHash('sha256');
            hash.update(`${helpers.getDocumentID(game)}|${serverInfo.salt}`);
            let key = hash.digest('hex');

            let mapInfo = MAPS[game.map];

            debug(`resetting server ${game.server} for game ${game.id}`);
            await self.resetServer(game.server, false);

            debug(`performing initial setup for server ${game.server} for game ${game.id}`);
            await self.sendRCONCommands(game.server, [`pugchamp_api_url "${BASE_URL}/api/servers/${key}"`, `pugchamp_game_id "${helpers.getDocumentID(game)}"`, `pugchamp_game_map "${mapInfo.file}"`, `pugchamp_game_config "${mapInfo.config}"`]);

            await self.updateServerStatus(game.server);
            await self.updateServerPlayers(game, false);

            try {
                debug(`launching server ${game.server} for game ${game.id}`);
                await self.sendRCONCommands(game.server, ['pugchamp_game_start']);
            }
            finally {
                await self.updateServerStatus(game.server);
                let serverStatus = await self.getServerStatus(game.server);

                if (serverStatus.status !== 'assigned' || helpers.getDocumentID(serverStatus.game) !== helpers.getDocumentID(game) || serverStatus.game.status === 'initializing') {
                    debug(`game server ${game.server} not launched for game ${game.id}, waiting and retrying`);

                    await helpers.promiseDelay(MAP_CHANGE_TIMEOUT);

                    serverStatus = await self.getServerStatus(game.server);

                    if (serverStatus.status !== 'assigned' || helpers.getDocumentID(serverStatus.game) !== helpers.getDocumentID(game) || serverStatus.game.status === 'initializing') {
                        debug(`game server ${game.server} not launched for game ${game.id}`);
                        throw new Error('game server not launched');
                    }
                }
            }

            success = true;
        }
        catch (err) {
            debug(`encountered error while trying to initialize server for game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    await helpers.promiseDelay(delay);

                    try {
                        await self.initializeServer(game, false);

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
    };

    self.assignGameToServer = async function assignGameToServer(game, requestedServer, retry = true) {
        let success = false;

        try {
            debug(`assigning game ${game.id} to server`);

            debug(`resetting status of game ${game.id} to initializing`);
            game.status = 'initializing';
            game.server = null;
            await game.save();

            debug(`updating game ${game.id}`);
            await self.processGameUpdate(game);

            if (!requestedServer) {
                debug(`randomly assigning game ${game.id} to available server`);

                let server = await self.findAvailableServer();

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
            await game.save();

            debug(`updating game ${game.id}`);
            await self.processGameUpdate(game);

            await self.initializeServer(game, false);

            success = true;
        }
        catch (err) {
            debug(`encountered error while trying to assign server for game ${helpers.getDocumentID(game)}: ${err.stack}`);

            if (retry) {
                for (let delay of RETRY_ATTEMPTS) {
                    debug(`waiting for ${delay}ms before retrying`);
                    await helpers.promiseDelay(delay);

                    try {
                        await self.assignGameToServer(game, requestedServer, false);

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
    };

    app.get('/servers', async function(req, res) {
        let servers = await self.getServerStatuses();

        res.render('servers', {
            servers: _.mapValues(servers, (status, name) => ({
                server: _.omit(GAME_SERVER_POOL[name], 'rcon', 'salt'),
                status
            }))
        });
    });

    app.post('/api/servers/:key', bodyParser.urlencoded({
        extended: true
    }), async function(req, res) {
        if (!req.body.game) {
            res.sendStatus(HttpStatus.BAD_REQUEST);
            return;
        }

        let game = await database.Game.findById(req.body.game);

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
            await self.handleGameServerUpdate(req.body);

            res.sendStatus(HttpStatus.OK);
        }
        catch (err) {
            debug(`failed to handle update for game ${helpers.getDocumentID(game)} (${JSON.stringify(req.body)}): ${err.stack}`);

            let success = false;

            for (let delay of RETRY_ATTEMPTS) {
                await helpers.promiseDelay(delay);

                try {
                    await self.handleGameServerUpdate(req.body);

                    success = true;
                    break;
                }
                catch (err) {
                    debug(`failed to handle update for game ${helpers.getDocumentID(game)} (${JSON.stringify(req.body)}): ${err.stack}`);

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

        await self.updateServerStatus(game.server);
    });

    (async function() {
        await self.updateServerStatuses();

        for (let server of _.keys(GAME_SERVER_POOL)) {
            rconConnectionLimits.set(server, new RateLimiter(1, RECONNECT_INTERVAL));
            setupRCON(server);
            establishRCONConnection(server);
        }

        setInterval(async function() {
            await self.updateServerStatuses();
            let serverStatuses = await self.getServerStatuses();

            await Promise.all(_.map(serverStatuses, async function(serverStatus, server) {
                if (serverStatus.status === 'unreachable' || serverStatus.status === 'unknown' || serverStatus.status === 'unavailable') {
                    self.postToLog({
                        description: `server \`${server}\` is currently ${serverStatus.status}`
                    });
                }
                else if (serverStatus.status === 'assigned') {
                    let updatedGame = await database.Game.findById(helpers.getDocumentID(serverStatus.game));

                    if (updatedGame.status !== 'launching' && updatedGame.status !== 'live') {
                        self.postToLog({
                            description: `server \`${server}\` is currently assigned to game \`<${BASE_URL}/game/${helpers.getDocumentID(serverStatus.game)}|${helpers.getDocumentID(serverStatus.game)}>\` which is ${updatedGame.status}`
                        });
                    }
                }
            }));
        }, RECHECK_INTERVAL);
    })();
};
