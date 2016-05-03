/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').argv;
const co = require('co');
const config = require('config');
const math = require('mathjs');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

function isActivePlayer(player) {
    if (!player.authorized) {
        return false;
    }

    if ((!_.isNil(player.stats.total.captain) && player.stats.total.captain > 0) || (!_.isNil(player.stats.total.player) && player.stats.total.player > 0)) {
        return true;
    }

    return false;
}

function formatPlayerListing(player, includeRating) {
    if (includeRating) {
        return {
            id: helpers.getDocumentID(player),
            alias: player.alias,
            steamID: player.steamID,
            groups: _.get(player.toObject(), 'groups'),
            ratingMean: math.round(player.stats.rating.mean),
            ratingDeviation: math.round(player.stats.rating.deviation),
            ratingLowerBound: math.round(player.stats.rating.low),
            ratingUpperBound: math.round(player.stats.rating.high),
            captainScore: player.stats.captainScore && _.isNumber(player.stats.captainScore.center) ? math.round(player.stats.captainScore.center, 3) : null,
            playerScore: player.stats.playerScore && _.isNumber(player.stats.playerScore.center) ? math.round(player.stats.playerScore.center, 3) : null
        };
    }
    else {
        return {
            id: helpers.getDocumentID(player),
            alias: player.alias,
            steamID: player.steamID,
            groups: _.get(player.toObject(), 'groups')
        };
    }
}

co(function*() {
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const RESTRICTION_DURATIONS = config.get('app.users.restrictionDurations');

    try {
        let users;

        if (_.size(argv._) > 0) {
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

        for (let user of users) {
            let userID = helpers.getDocumentID(user);

            yield cache.setAsync(`user-${userID}`, JSON.stringify(user.toObject()));

            /* eslint-disable lodash/prefer-lodash-method */
            let games = yield database.Game.find({
                $or: [{
                    'teams.captain': userID
                }, {
                    'teams.composition.players': {
                        $elemMatch: {
                            user: userID
                        }
                    }
                }],
                status: {
                    $in: ['launching', 'live', 'completed']
                }
            }).sort('-date').populate('teams.captain').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            /* eslint-disable lodash/prefer-lodash-method */
            let restrictions = yield database.Restriction.find({
                'user': userID
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */

            let playerPage = {
                user: user.toObject(),
                games: _.map(games, function(game) {
                    let revisedGame = _.omit(game.toObject(), 'draft', 'server', 'links');

                    if (userID === helpers.getDocumentID(game.teams[0].captain)) {
                        revisedGame.reverseTeams = false;
                    }
                    else if (userID === helpers.getDocumentID(game.teams[1].captain)) {
                        revisedGame.reverseTeams = true;
                    }
                    else {
                        let gameUserInfo = helpers.getGameUserInfo(game, user);
                        let team = _.indexOf(game.teams, gameUserInfo.team);

                        revisedGame.reverseTeams = team !== 0;
                    }

                    return revisedGame;
                }),
                restrictions: _(restrictions).invokeMap('toObject').orderBy(['active', 'expires'], ['desc', 'desc']).value(),
                restrictionDurations: RESTRICTION_DURATIONS
            };

            if (!HIDE_RATINGS) {
                /* eslint-disable lodash/prefer-lodash-method */
                let ratings = yield database.Rating.find({
                    'user': userID
                }).exec();
                /* eslint-enable lodash/prefer-lodash-method */

                playerPage.ratings = _(ratings).invokeMap('toObject').sortBy('date').value();
            }

            yield cache.setAsync(`playerPage-${userID}`, JSON.stringify(playerPage));
        }

        let players = _.orderBy(
            /* eslint-disable lodash/prefer-lodash-method */
            yield database.User.find({}).exec(),
            /* eslint-enable lodash/prefer-lodash-method */
            [function(player) {
                return player.stats.rating.mean;
            }, function(player) {
                return player.stats.playerScore ? player.stats.playerScore.center : null;
            }, function(player) {
                return player.stats.captainScore ? player.stats.captainScore.center : null;
            }], ['desc', 'desc', 'desc']);

        yield cache.setAsync('allPlayerList', JSON.stringify(_.map(players, user => formatPlayerListing(user, !HIDE_RATINGS))));
        yield cache.setAsync('activePlayerList', JSON.stringify(_(players).filter(user => isActivePlayer(user)).map(user => formatPlayerListing(user, !HIDE_RATINGS)).value()));

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
