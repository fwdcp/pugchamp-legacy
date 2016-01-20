/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const config = require('config');

module.exports = function(app, database, io, self) {
    const ROLES = config.get('app.games.roles');

    function getPlayerDraftStats(player) {
        return co(function*() {
            if (!player) {
                return null;
            }

            let stats = {};

            stats.Captain = yield database.Game.count({
                'teams.captain': player.id
            }).count().exec();

            for (let role of _.toPairs(ROLES)) {
                stats['Picked ' + role[1].name] = yield database.Game.find({
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'role': role[0],
                            'player': player.id
                        }
                    }
                }).count().exec();
            }

            stats.Undrafted = yield database.Game.find({
                'draft.choices': {
                    $not: {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': player.id
                        }
                    }
                },
                'draft.pool.players.user': player.id
            }).count().exec();

            return stats;
        });
    }

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            steamID: req.params.steam
        }).populate('currentRating').exec();

        let games = yield database.Game.find({
            $or: [{
                'teams.captain': user.id
            }, {
                'teams.composition.players': {
                    $elemMatch: {
                        user: user.id
                    }
                }
            }]
        }).sort('-date').populate('teams.captain').exec();

        let ratings = yield database.Rating.find({
            'user': user.id
        }).populate('game', 'date').exec();

        let draftStats = yield getPlayerDraftStats(user);

        res.render('player', {
            user: user,
            games: games,
            ratings: _(ratings).map(rating => ({
                game: rating.game.id,
                date: rating.game.date,
                mean: rating.after.rating,
                lowerBound: rating.after.rating - (3 * rating.after.deviation),
                upperBound: rating.after.rating + (3 * rating.after.deviation)
            })).sortBy('date').value(),
            draftStats: draftStats
        });
    }));

    app.get('/players', co.wrap(function*(req, res) {
        let users = yield database.User.find({
            $or: [{
                'currentRating': {
                    $exists: true
                }
            }, {
                'captainScore.low': {
                    $exists: true
                }
            }]
        }).populate('currentRating').exec();

        let players = _(users).orderBy([function(user) {
            if (user.currentRating) {
                return user.currentRating.after.rating;
            }

            return Number.NEGATIVE_INFINITY;
        }, function(user) {
            if (user.currentRating) {
                return user.currentRating.after.deviation;
            }

            return Number.POSITIVE_INFINITY;
        }, function(user) {
            if (_.has(user.captainScore, 'low')) {
                return user.captainScore.low;
            }

            return Number.NEGATIVE_INFINITY;
        }], ['desc', 'asc', 'desc']).map(user => user.toObject()).value();

        res.render('playerList', {
            players: players
        });
    }));
};
