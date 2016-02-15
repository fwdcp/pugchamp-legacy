'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const hbs = require('hbs');
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
            'score': {
                $exists: true
            }
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
            'teams.composition': {
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

    hbs.registerHelper('draftStatToRow', function(stat) {
        if (stat.type === 'captain') {
            return JSON.stringify(['Captain', stat.number]);
        }
        else if (stat.type === 'picked') {
            return JSON.stringify(['Picked ' + ROLES[stat.role].name, stat.number]);
        }
        else if (stat.type === 'undrafted') {
            return JSON.stringify(['Undrafted', stat.number]);
        }
    });
    hbs.registerHelper('ratingStatToRow', function(stat) {
        return '[new Date("' + stat.date + '"),' + stat.after.mean + ',' + stat.after.low + ',' + stat.after.high + ']';
    });
    hbs.registerHelper('roleStatToRow', function(stat) {
        return JSON.stringify([ROLES[stat.role].name, stat.number]);
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
            user: user.toObject(),
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
            ratings: _(ratings).map(rating => rating.toObject()).sortBy('date').value(),
            restrictions: _(restrictions).map(restriction => restriction.toObject()).orderBy(['active', 'expires'], ['desc', 'desc']).value()
        });
    }));

    app.get('/players', function(req, res) {
        let users = self.getCachedUsers();

        if (!req.user || !req.user.admin) {
            users = _.filter(users, function(user) {
                if (!user.authorized) {
                    return false;
                }

                if (user.stats.roles) {
                    for (let stat of user.stats.roles) {
                        if (stat.number > 0) {
                            return true;
                        }
                    }
                }

                if (user.stats.draft) {
                    for (let stat of user.stats.draft) {
                        if (stat.type === 'captain' && stat.number > 0) {
                            return true;
                        }
                    }
                }                

                return false;
            });
        }

        res.render('playerList', {
            players: _(users).orderBy([function(user) {
                return user.stats.rating.low;
            }, function(user) {
                return user.stats.captainScore ? user.stats.captainScore.low : null;
            }], ['desc', 'desc']).map(user => ({
                id: user.id,
                alias: user.alias,
                steamID: user.steamID,
                ratingMean: math.round(user.stats.rating.mean),
                ratingDeviation: math.round(user.stats.rating.deviation),
                ratingLowerBound: math.round(user.stats.rating.low),
                ratingUpperBound: math.round(user.stats.rating.high),
                captainScore: user.stats.captainScore && _.isNumber(user.stats.captainScore.low) ? math.round(user.stats.captainScore.low, 3) : null
            })).value()
        });
    });
};
