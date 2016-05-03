/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').argv;
const co = require('co');
const config = require('config');
const moment = require('moment');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

co(function*() {
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const ROLES = config.get('app.games.roles');

    try {
        let games;

        if (_.size(argv._) > 0) {
            /* eslint-disable lodash/prefer-lodash-method */
            games = yield database.Game.find({
                '_id': {
                    $in: argv._
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            games = yield database.Game.find({}).exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        for (let game of games) {
            let gameID = helpers.getDocumentID(game);

            let gamePage = {
                game: game.toObject()
            };

            let gameUsers = _(
                /* eslint-disable lodash/prefer-lodash-method */
                yield database.User.find({
                    '_id': {
                        $in: _.map(helpers.getGameUsers(game), user => helpers.getDocumentID(user))
                    }
                }).exec()
                /* eslint-enable lodash/prefer-lodash-method */
            ).invokeMap('toObject').keyBy(user => helpers.getDocumentID(user)).value();

            /* eslint-disable lodash/prefer-lodash-method */
            let ratings = HIDE_RATINGS ? {} : _.keyBy(yield database.Rating.find({
                game: gameID
            }).exec(), rating => helpers.getDocumentID(rating.user));
            /* eslint-enable lodash/prefer-lodash-method */

            _.forEach(gamePage.game.teams, function(team) {
                team.captain = gameUsers[helpers.getDocumentID(team.captain)];

                team.composition = _.sortBy(team.composition, function(role) {
                    return _(ROLES).keys().indexOf(role.role);
                });

                _.forEach(team.composition, function(role) {
                    role.role = _.assign({
                        id: role.role
                    }, ROLES[role.role]);

                    _.forEach(role.players, function(player) {
                        player.user = gameUsers[helpers.getDocumentID(player.user)];

                        if (!HIDE_RATINGS) {
                            let rating = ratings[helpers.getDocumentID(player.user)];

                            if (rating) {
                                player.rating = {
                                    rating: rating.after.mean,
                                    deviation: rating.after.deviation,
                                    change: rating.after.mean - rating.before.mean
                                };
                            }
                        }
                    });
                });
            });

            yield cache.setAsync(`gamePage-${gameID}`, JSON.stringify(gamePage));
        }

        /* eslint-disable lodash/prefer-lodash-method */
        let gamesCache = yield database.Game.find({}).sort('-date').select('date status teams.faction teams.captain score map duration').populate('teams.captain', 'alias steamID').exec();
        /* eslint-enable lodash/prefer-lodash-method */

        yield cache.setAsync('allGameList', JSON.stringify(_.invokeMap(gamesCache, 'toObject')));
        yield cache.setAsync('allVisibleGameList', JSON.stringify(_(gamesCache).filter(game => game.status !== 'initializing' && game.status !== 'aborted').invokeMap('toObject').value()));
        yield cache.setAsync('recentGameList', JSON.stringify(_(gamesCache).takeWhile(game => moment().diff(game.date, 'days') < 1).invokeMap('toObject').value()));
        yield cache.setAsync('recentVisibleGameList', JSON.stringify(_(gamesCache).takeWhile(game => moment().diff(game.date, 'days') < 1).filter(game => game.status !== 'initializing' && game.status !== 'aborted').invokeMap('toObject').value()));

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
