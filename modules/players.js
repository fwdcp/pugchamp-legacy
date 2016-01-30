/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const math = require('mathjs');

module.exports = function(app, chance, database, io, self) {
    function calculatePredictionInterval(samples) {
        let n = _.size(samples);

        if (n > 1) {
            let mean = math.mean(samples);
            let deviation = math.std(samples);

            let distribution = new distributions.Studentt(n - 1);

            let low = mean + (distribution.inv(0.16) * deviation * math.sqrt(1 + (1 / n)));
            let high = mean + (distribution.inv(0.84) * deviation * math.sqrt(1 + (1 / n)));

            return {
                low: low >= 0 ? low : 0,
                center: mean,
                high: high <= 1 ? high : 1
            };
        }
        else if (n === 1) {
            let mean = math.mean(samples);

            return {
                low: null,
                center: mean,
                high: null
            };
        }
        else {
            return {
                low: null,
                center: null,
                high: null
            };
        }
    }

    const ROLES = config.get('app.games.roles');

    self.updatePlayerStats = co.wrap(function*(playerID) {
        let player = yield database.User.findById(playerID);

        let captainGames = yield database.Game.find({
            'teams.captain': player.id,
            'status': 'completed',
            'score': {$exists: true}
        });

        let scores = _.map(captainGames, function(game) {
            let totalScore = math.sum(...game.score);

            if (totalScore > 0) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return self.getDocumentID(team.captain) === player.id;
                });

                return game.score[teamIndex] / totalScore;
            }
            else {
                return 0.5;
            }
        });

        player.stats.captainScore = calculatePredictionInterval(scores);

        player.stats.draft = yield _(ROLES).keys().map(role => database.Game.find({
            'draft.choices': {
                $elemMatch: {
                    'type': 'playerPick',
                    'role': role,
                    'player': player.id
                }
            }
        }).count().exec().then(count => ({
            type: 'picked',
            role: role,
            number: count
        }))).concat(database.Game.count({
            'teams.captain': player.id
        }).count().exec().then(count => ({
            type: 'captain',
            number: count
        })), database.Game.find({
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
        }).count().exec().then(count => ({
            type: 'undrafted',
            number: count
        }))).value();

        let rating = yield database.Rating.findOne({
            user: player.id
        }).sort('-date').exec();

        if (rating) {
            player.stats.rating.mean = rating.after.mean;
            player.stats.rating.deviation = rating.after.deviation;
        }

        player.stats.roles = yield _(ROLES).keys().map(role => database.Game.find({
            'game.teams.composition': {
                $elemMatch: {
                    'role': role,
                    'players.user': player.id
                }
            }
        }).count().exec().then(count => ({
            role: role,
            number: count
        }))).value();

        yield player.save();

        yield self.updateCachedUser(player.id);
    });

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            steamID: req.params.steam
        }).exec();

        if (!user) {
            res.sendStatus(404);
            return;
        }

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

        let restrictions = yield database.Restriction.find({
            user: user.id
        }).exec();

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
                    let gamePlayerInfo = self.getGamePlayerInfo(game, user.id);
                    let team = _.indexOf(game.teams, gamePlayerInfo.team);

                    revisedGame.reverseTeams = team !== 0;
                }

                return revisedGame;
            }).value(),
            ratings: _(ratings).map(rating => ({
                game: rating.game.id,
                date: rating.game.date,
                mean: rating.after.mean,
                lowerBound: rating.after.mean - (3 * rating.after.deviation),
                upperBound: rating.after.mean + (3 * rating.after.deviation)
            })).sortBy('date').value(),
            restrictions: _(restrictions).map(restriction => restriction.toObject()).orderBy(['active', 'expires'], ['desc', 'desc']).value()
        });
    }));

    app.get('/players', co.wrap(function*(req, res) {
        let users = yield database.User.find({
            $or: [{
                'stats.rating.mean': {
                    $exists: true
                }
            }, {
                'stats.captainScore.low': {
                    $exists: true
                }
            }]
        }).exec();

        let players = _(users).orderBy([function(user) {
            return user.stats.rating.low;
        }, function(user) {
            return user.stats.captainScore.low;
        }], ['desc', 'desc']).map(user => ({
            id: user.id,
            alias: user.alias,
            steamID: user.steamID,
            ratingMean: user.stats.rating.mean,
            ratingDeviation: user.stats.rating.deviation,
            ratingLowerBound: user.stats.rating.low,
            ratingUpperBound: user.stats.rating.high,
            captainScore: user.stats.captainScore.low
        })).value();

        res.render('playerList', {
            players: players
        });
    }));
};
