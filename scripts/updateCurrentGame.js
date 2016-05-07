/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const co = require('co');
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updateCurrentGame');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

co(function*() {
    const GAME_SERVER_POOL = config.get('app.servers.pool');
    const ROLES = config.get('app.games.roles');

    try {
        let users;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({
                '_id': {
                    $in: argv._
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({}).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        debug(`updating current game for ${_.size(users)} users`);

        for (let user of users) {
            let userID = helpers.getDocumentID(user);

            let game = yield database.Game.findOne({
                $or: [{
                    'teams.captain': userID
                }, {
                    'teams.composition.players.user': userID
                }],
                status: {
                    $in: ['initializing', 'launching', 'live']
                }
            }).populate('teams.captain teams.composition.players.user').exec();

            if (game) {
                let gameUserInfo = helpers.getGameUserInfo(game.toObject(), user);

                let currentGameInfo = {
                    game: helpers.getDocumentID(game),
                    team: _.omit(gameUserInfo.team, 'composition'),
                    user: user.toObject()
                };

                currentGameInfo.team.captain = gameUserInfo.team.captain;

                currentGameInfo.player = gameUserInfo.role && gameUserInfo.player;
                if (currentGameInfo.player) {
                    currentGameInfo.role = ROLES[gameUserInfo.role.role];
                    currentGameInfo.replaced = gameUserInfo.player.replaced;

                    if (!currentGameInfo.replaced && game.server && game.status !== 'initializing') {
                        currentGameInfo.server = _.omit(GAME_SERVER_POOL[game.server], 'rcon', 'salt');
                        currentGameInfo.server.id = game.server;
                    }
                }

                currentGameInfo.captain = helpers.getDocumentID(gameUserInfo.team.captain) === userID;
                if (currentGameInfo.captain) {
                    currentGameInfo.activeTeamPlayers = yield _(gameUserInfo.team.composition).map(role => _(role.players).reject('replaced').map(player => ({
                        user: player.user,
                        role: ROLES[role.role]
                    })).value()).flattenDeep().map(function(player) {
                        player.user = player.user;

                        return player;
                    }).value();
                }

                yield cache.setAsync(`currentGame-${userID}`, JSON.stringify(currentGameInfo));
            }
            else {
                yield cache.delAsync(`currentGame-${userID}`);
            }
        }

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
