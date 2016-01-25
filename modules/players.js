/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const config = require('config');
const math = require('mathjs');

module.exports = function(app, chance, database, io, self) {
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
                $nor: [{
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': player.id
                        }
                    }
                }, {
                    'teams.captain': player.id
                }],
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

        let draftStats;

        if (user.options.showDraftStats) {
            draftStats = yield getPlayerDraftStats(user);
        }

        let restrictions = yield database.Restriction.find({
            user: user.id
        }).populate('actions.admin').exec();

        res.render('player', {
            user: user,
            games: _(games).map(function(game) {
                let revisedGame = _.omit(game.toObject(), 'draft', 'server', 'links');

                if (self.getDocumentID(user) === self.getDocumentID(game.teams[0].captain)) {
                    revisedGame.reverseTeams = false;
                }
                else if (self.getDocumentID(user) === self.getDocumentID(game.teams[1].captain)) {
                    revisedGame.reverseTeams = true;
                }
                else {
                    let gamePlayerInfo = self.getGamePlayerInfo(game, user);
                    let team = _.indexOf(game.teams, gamePlayerInfo.team);

                    revisedGame.reverseTeams = team !== 0;
                }

                return revisedGame;
            }).value(),
            ratings: _(ratings).map(rating => ({
                game: rating.game.id,
                date: rating.game.date,
                mean: rating.after.rating,
                lowerBound: rating.after.rating - (3 * rating.after.deviation),
                upperBound: rating.after.rating + (3 * rating.after.deviation)
            })).sortBy('date').value(),
            draftStats: draftStats ? _.toPairs(draftStats) : null,
            restrictions: _(restrictions).map(restriction => restriction.toObject()).orderBy(['active', 'expires'], ['desc', 'desc']).value()
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
        }], ['desc', 'asc', 'desc']).map(user => ({
            id: user.id,
            steamID: user.steamID,
            alias: user.alias,
            rating: user.currentRating ? math.round(user.currentRating.after.rating) : null,
            deviation: user.currentRating ? math.round(user.currentRating.after.deviation) : null,
            captainScore: _.has(user.captainScore, 'low') ? math.round(user.captainScore.low, 3) : null,
        })).value();

        res.render('playerList', {
            players: players
        });
    }));
};
