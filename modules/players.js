'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const humanize = require('humanize');
const math = require('mathjs');

module.exports = function(app, cache, chance, database, io, self) {
    const ONE_DEVIATION_LOWER_BOUND = 0.16;
    const ONE_DEVIATION_UPPER_BOUND = 0.84;

    function calculatePredictionInterval(samples) {
        let n = _.size(samples);

        if (n > 1) {
            let mean = math.mean(samples);
            let deviation = math.std(samples);

            let distribution = new distributions.Studentt(n - 1);

            let low = mean + (distribution.inv(ONE_DEVIATION_LOWER_BOUND) * deviation * math.sqrt(1 + (1 / n)));
            let high = mean + (distribution.inv(ONE_DEVIATION_UPPER_BOUND) * deviation * math.sqrt(1 + (1 / n)));

            return {
                low,
                center: mean,
                high
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

    const DRAFT_ORDER = config.get('app.draft.order');
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const RESTRICTION_DURATIONS = config.get('app.users.restrictionDurations');
    const ROLES = config.get('app.games.roles');
    const UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT = 60000;
    const UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT = 5000;

    function isActivePlayer(player) {
        if (!player.authorized) {
            return false;
        }

        if (player.stats.total.captain > 0 || player.stats.total.player > 0) {
            return true;
        }

        return false;
    }

    function formatPlayerListing(player, includeRating) {
        if (includeRating) {
            return {
                id: player.id,
                alias: player.alias,
                steamID: player.steamID,
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
                id: player.id,
                alias: player.alias,
                steamID: player.steamID
            };
        }
    }

    /**
     * @async
     */
    const updatePlayerList = _.debounce(co.wrap(function* updatePlayerCache() {
        let users = yield database.User.find({}).exec();

        let players = _.orderBy(users, [function(player) {
            return player.stats.rating.mean;
        }, function(player) {
            return player.stats.playerScore ? player.stats.playerScore.center : null;
        }, function(player) {
            return player.stats.captainScore ? player.stats.captainScore.center : null;
        }], ['desc', 'desc', 'desc']);

        yield cache.setAsync('allPlayerList', _.map(players, user => formatPlayerListing(user, !HIDE_RATINGS)));
        yield cache.setAsync('activePlayerList', _(players).filter(user => isActivePlayer(user)).map(user => formatPlayerListing(user, !HIDE_RATINGS)).value());
    }), UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT, {
        maxWait: UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT
    });

    /**
     * @async
     */
    function getPlayerList(inactive) {
        return co(function*() {
            let keyName;

            if (inactive) {
                keyName = 'allPlayerList';
            }
            else {
                keyName = 'activePlayerList';
            }

            let cacheResponse = yield cache.getAsync(keyName);

            if (!cacheResponse) {
                yield updatePlayerList();
                cacheResponse = yield cache.getAsync(keyName);
            }

            return JSON.parse(cacheResponse);
        });
    }

    self.on('cachedUserUpdated', co.wrap(function*(user) {
        yield self.invalidatePlayerPage(user);
        yield updatePlayerList();
    }));

    /**
     * @async
     */
    self.updatePlayerStats = co.wrap(function* updatePlayerStats(player) {
        let playerID = self.getDocumentID(player);
        player = yield database.User.findById(playerID);

        let captainGames = yield database.Game.find({
            'teams.captain': player.id,
            'status': 'completed',
            'score': {
                $exists: true
            }
        });

        let captainScores = _.map(captainGames, function(game) {
            let teamIndex = _.findIndex(game.teams, function(team) {
                return self.getDocumentID(team.captain) === player.id;
            });

            let differential = 0;

            if (teamIndex === 0) {
                differential = (game.score[0] - game.score[1]) / 5;
            }
            else if (teamIndex === 1) {
                differential = (game.score[1] - game.score[0]) / 5;
            }

            let duration = game.duration ? game.duration / 1800 : 1;

            return differential / duration;
        });

        player.stats.captainScore = calculatePredictionInterval(captainScores);

        let playerGames = yield database.Game.find({
            'teams.composition.players.user': player.id,
            'status': 'completed',
            'score': {
                $exists: true
            }
        });

        let playerScores = _.map(playerGames, function(game) {
            let gameUserInfo = self.getGameUserInfo(game, player);
            let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

            let differential = 0;

            if (teamIndex === 0) {
                differential = (game.score[0] - game.score[1]) / 5;
            }
            else if (teamIndex === 1) {
                differential = (game.score[1] - game.score[0]) / 5;
            }

            let duration = game.duration ? game.duration / 1800 : 1;

            return differential / duration;
        });

        player.stats.playerScore = calculatePredictionInterval(playerScores);

        let draftStats = [];

        let captainGameCount = yield database.Game.count({
            'teams.captain': player.id
        }).count().exec();
        draftStats.push({
            type: 'captain',
            count: captainGameCount
        });

        let draftPositions = {};

        let playersPicked = _(DRAFT_ORDER).filter(function(turn) {
            return turn.type === 'playerPick';
        }).size();
        for (let i = 1; i <= playersPicked; i++) {
            draftPositions[i] = 0;
        }

        let draftedGames = yield database.Game.find({
            'draft.choices': {
                $elemMatch: {
                    'type': 'playerPick',
                    'player': player.id
                }
            }
        }).exec();
        for (let game of draftedGames) {
            let position = 0;

            for (let choice of game.draft.choices) {
                if (choice.type === 'playerPick') {
                    position++;

                    if (self.getDocumentID(choice.player) === self.getDocumentID(player)) {
                        break;
                    }
                }
            }

            if (!draftPositions[position]) {
                draftPositions[position] = 0;
            }
            draftPositions[position]++;
        }

        _.each(draftPositions, function(count, position) {
            draftStats.push({
                type: 'picked',
                position,
                count
            });
        });

        let undraftedCount = yield database.Game.find({
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
        draftStats.push({
            type: 'undrafted',
            count: undraftedCount
        });

        player.stats.draft = draftStats;

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
            role,
            count
        }))).value();

        player.stats.total.captain = yield database.Game.count({
            'teams.captain': player.id
        }).count().exec();
        player.stats.total.player = yield database.Game.count({
            'teams.composition.players.user': player.id
        }).count().exec();

        yield player.save();

        yield self.updateCachedUser(player);
    });

    hbs.registerHelper('draftStatToRow', function(stat) {
        if (stat.type === 'captain') {
            return JSON.stringify(['Captain', stat.count]);
        }
        else if (stat.type === 'picked') {
            return JSON.stringify([`Picked ${humanize.ordinal(stat.position)}`, stat.count]);
        }
        else if (stat.type === 'undrafted') {
            return JSON.stringify(['Undrafted', stat.count]);
        }
    });
    hbs.registerHelper('ratingStatToRow', function(stat) {
        return `[new Date("${stat.date}"),${stat.after.mean},${stat.after.low},${stat.after.high}]`;
    });
    hbs.registerHelper('roleStatToRow', function(stat) {
        return JSON.stringify([ROLES[stat.role].name, stat.count]);
    });

    /**
     * @async
     */
    self.invalidatePlayerPage = co.wrap(function* invalidatePlayerPage(player) {
        yield cache.delAsync(`playerPage-${self.getDocumentID(player)}`);
    });

    /**
     * @async
     */
    self.getPlayerPage = co.wrap(function* getPlayerPage(player) {
        let cacheResponse = yield cache.getAsync(`playerPage-${self.getDocumentID(player)}`);

        let playerPage;

        if (cacheResponse) {
            playerPage = JSON.parse(cacheResponse);
        }
        else {
            let user = yield database.User.findById(self.getDocumentID(player));

            if (!user) {
                return null;
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
                }],
                status: {
                    $in: ['launching', 'live', 'completed']
                }
            }).sort('-date').populate('teams.captain').exec();

            let restrictions = yield database.Restriction.find({
                'user': user.id
            }).exec();

            playerPage = {
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
                        let gameUserInfo = self.getGameUserInfo(game, user);
                        let team = _.indexOf(game.teams, gameUserInfo.team);

                        revisedGame.reverseTeams = team !== 0;
                    }

                    return revisedGame;
                }).value(),
                restrictions: _(restrictions).map(restriction => restriction.toObject()).orderBy(['active', 'expires'], ['desc', 'desc']).value(),
                restrictionDurations: RESTRICTION_DURATIONS
            };

            if (!HIDE_RATINGS) {
                let ratings = yield database.Rating.find({
                    'user': user.id
                }).exec();

                playerPage.ratings = _(ratings).map(rating => rating.toObject()).sortBy('date').value();
            }

            yield cache.setAsync(`playerPage-${self.getDocumentID(user)}`, playerPage);
        }

        return playerPage;
    });

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            'steamID': req.params.steam
        }).exec();

        let playerPage = yield self.getPlayerPage(user);

        if (playerPage) {
            res.render('player', playerPage);
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    }));

    app.get('/players', co.wrap(function*(req, res) {
        res.render('playerList', {
            players: yield getPlayerList(self.isUserAdmin(req.user))
        });
    }));

    co(function*() {
        let users = yield database.User.find({}, '_id').exec();
        yield _.map(users, user => self.updatePlayerStats(user));

        yield updatePlayerList();
    });
};
