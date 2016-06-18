/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const co = require('co');
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updateUserCache');
const math = require('mathjs');
const moment = require('moment');
const ms = require('ms');

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

function calculatePenaltyHistory(penalties, durations, resetInterval) {
    let history = [];

    let level = 0;
    let eventDate = moment(0);

    for (let penalty of penalties) {
        while (level > 0 && moment(penalty.date).diff(eventDate, 'ms') >= resetInterval) {
            eventDate.add(resetInterval, 'ms');
            level -= 1;

            history.push({
                type: 'reset',
                date: eventDate.toDate(),
                level
            });
        }

        level += 1;

        eventDate = moment(penalty.date);

        let duration = 0;
        if (level - 1 < durations.length) {
            duration = durations[level - 1];
        }
        else {
            duration = _.last(durations);
        }

        eventDate.add(duration, 'ms');

        history.push({
            type: 'penalty',
            date: penalty.date,
            level,
            reason: penalty.reason,
            duration: ms(duration, {
                long: true
            })
        });
    }

    while (level > 0 && moment().diff(eventDate, 'ms') >= resetInterval) {
        eventDate.add(resetInterval, 'ms');
        level -= 1;

        history.push({
            type: 'reset',
            date: eventDate.toDate(),
            level
        });
    }

    return history;
}

co(function*() {
    const CAPTAIN_PENALTY_COOLDOWNS = _.map(config.get('app.users.penaltyCooldowns.captain'), duration => ms(duration));
    const GENERAL_PENALTY_COOLDOWNS = _.map(config.get('app.users.penaltyCooldowns.general'), duration => ms(duration));
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const PENALTY_LEVEL_RESET_INTERVAL = ms(config.get('app.users.penaltyLevelResetInterval'));
    const RESTRICTION_DURATIONS = config.get('app.users.restrictionDurations');

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

        debug(`updating user cache for ${_.size(users)} users`);

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
            }).sort('-date').select('date status teams.faction teams.captain teams.composition score map duration').populate('teams.captain', 'alias steamID').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            /* eslint-disable lodash/prefer-lodash-method */
            let restrictions = yield database.Restriction.find({
                'user': userID
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */

            /* eslint-disable lodash/prefer-lodash-method */
            let generalPenalties = yield database.Penalty.find({
                'user': userID,
                'type': 'general',
                'active': true
            }).sort('date').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            /* eslint-disable lodash/prefer-lodash-method */
            let captainPenalties = yield database.Penalty.find({
                'user': userID,
                'type': 'captain',
                'active': true
            }).sort('date').exec();
            /* eslint-enable lodash/prefer-lodash-method */

            let gamesCache = _.map(games, function(game) {
                let revisedGame = _.cloneDeep(game.toObject());

                let gameUserInfo = helpers.getGameUserInfo(game, user);

                if (gameUserInfo) {
                    let team = _.indexOf(game.teams, gameUserInfo.team);

                    revisedGame.reverseTeams = team !== 0;
                }

                return revisedGame;
            });

            let playerPage = {
                user: user.toObject(),
                games: _(gamesCache).takeWhile(game => moment().diff(game.date, 'days') < 1).filter(game => game.status !== 'initializing' && game.status !== 'aborted').value(),
                restrictions: _(restrictions).invokeMap('toObject').orderBy(['active', 'expires'], ['desc', 'desc']).value(),
                restrictionDurations: RESTRICTION_DURATIONS,
                generalPenaltyHistory: _.reverse(calculatePenaltyHistory(generalPenalties, GENERAL_PENALTY_COOLDOWNS, PENALTY_LEVEL_RESET_INTERVAL)),
                captainPenaltyHistory: _.reverse(calculatePenaltyHistory(captainPenalties, CAPTAIN_PENALTY_COOLDOWNS, PENALTY_LEVEL_RESET_INTERVAL))
            };

            let playerGamesPage = {
                user: user.toObject(),
                games: _(gamesCache).filter(game => game.status !== 'initializing' && game.status !== 'aborted').value()
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
            yield cache.setAsync(`playerGamesPage-${userID}`, JSON.stringify(playerGamesPage));
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
