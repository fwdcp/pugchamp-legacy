'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const math = require('mathjs');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

function calculatePredictionInterval(samples) {
    const ONE_DEVIATION_LOWER_BOUND = 0.16;
    const ONE_DEVIATION_UPPER_BOUND = 0.84;

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

function getGameUserInfo(game, user) {
    let userID = helpers.getDocumentID(user);

    let team;
    let role;
    let player;

    team = _.find(game.teams, function(currentTeam) {
        role = _.find(currentTeam.composition, function(currentRole) {
            player = _.find(currentRole.players, function(currentPlayer) {
                return userID === helpers.getDocumentID(currentPlayer.user);
            });

            if (player) {
                return true;
            }

            return false;
        });

        if (role || userID === helpers.getDocumentID(currentTeam.captain)) {
            return true;
        }

        return false;
    });

    if (team) {
        return {
            game,
            team,
            role,
            player
        };
    }

    return null;
}

function updateCachedUser(user) {
    return co(function*() {
        let userID = helpers.getDocumentID(user);
        user = yield database.User.findById(userID);

        yield cache.setAsync(`user-${userID}`, JSON.stringify(user.toObject()));
    });
}

co(function*() {
    const DRAFT_ORDER = config.get('app.draft.order');
    const ROLES = config.get('app.games.roles');

    /* eslint-disable lodash/prefer-lodash-method */
    let users = yield database.User.find({}, 'alias stats.rating').exec();
    /* eslint-enable lodash/prefer-lodash-method */

    for (let user of users) {
        {
            /* eslint-disable lodash/prefer-lodash-method */
            let captainGames = yield database.Game.find({
                'teams.captain': helpers.getDocumentID(user),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            user.stats.captainRecord = _.countBy(captainGames, function(game) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return helpers.getDocumentID(team.captain) === helpers.getDocumentID(user);
                });

                if (teamIndex === 0) {
                    if (game.score[0] > game.score[1]) {
                        return 'win';
                    }
                    else if (game.score[0] < game.score[1]) {
                        return 'loss';
                    }
                    else if (game.score[0] === game.score[1]) {
                        return 'tie';
                    }
                }
                else if (teamIndex === 1) {
                    if (game.score[1] > game.score[0]) {
                        return 'win';
                    }
                    else if (game.score[1] < game.score[0]) {
                        return 'loss';
                    }
                    else if (game.score[1] === game.score[0]) {
                        return 'tie';
                    }
                }
            });
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let captainGames = yield database.Game.find({
                'teams.captain': helpers.getDocumentID(user),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            let captainScores = _.map(captainGames, function(game) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return helpers.getDocumentID(team.captain) === helpers.getDocumentID(user);
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

            user.stats.captainScore = calculatePredictionInterval(captainScores);
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let playerGames = yield database.Game.find({
                'teams.composition.players.user': helpers.getDocumentID(user),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            user.stats.playerRecord = _.countBy(playerGames, function(game) {
                let gameUserInfo = getGameUserInfo(game, user);
                let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

                if (teamIndex === 0) {
                    if (game.score[0] > game.score[1]) {
                        return 'win';
                    }
                    else if (game.score[0] < game.score[1]) {
                        return 'loss';
                    }
                    else if (game.score[0] === game.score[1]) {
                        return 'tie';
                    }
                }
                else if (teamIndex === 1) {
                    if (game.score[1] > game.score[0]) {
                        return 'win';
                    }
                    else if (game.score[1] < game.score[0]) {
                        return 'loss';
                    }
                    else if (game.score[1] === game.score[0]) {
                        return 'tie';
                    }
                }
            });
        }

        {
            /* eslint-disable lodash/prefer-lodash-method */
            let playerGames = yield database.Game.find({
                'teams.composition.players.user': helpers.getDocumentID(user),
                'status': 'completed',
                'score': {
                    $exists: true
                }
            });
            /* eslint-enable lodash/prefer-lodash-method */

            let playerScores = _.map(playerGames, function(game) {
                let gameUserInfo = getGameUserInfo(game, user);
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

            user.stats.playerScore = calculatePredictionInterval(playerScores);
        }

        {
            let draftStats = [];

            let captainGameCount = yield database.Game.count({
                'teams.captain': helpers.getDocumentID(user)
            }).count().exec();
            draftStats.push({
                type: 'captain',
                count: captainGameCount
            });

            let draftPositions = {};

            let playersPicked = _(DRAFT_ORDER).filter(['type', 'playerPick']).size();
            for (let i = 1; i <= playersPicked; i++) {
                draftPositions[i] = 0;
            }

            /* eslint-disable lodash/prefer-lodash-method */
            let draftedGames = yield database.Game.find({
                'draft.choices': {
                    $elemMatch: {
                        'type': 'playerPick',
                        'player': helpers.getDocumentID(user)
                    }
                }
            }).exec();
            /* eslint-enable lodash/prefer-lodash-method */
            for (let game of draftedGames) {
                let position = 0;

                for (let choice of game.draft.choices) {
                    if (choice.type === 'playerPick') {
                        position++;

                        if (helpers.getDocumentID(choice.player) === helpers.getDocumentID(user)) {
                            break;
                        }
                    }
                }

                if (!draftPositions[position]) {
                    draftPositions[position] = 0;
                }
                draftPositions[position]++;
            }


            _.forEach(draftPositions, function(count, position) {
                draftStats.push({
                    type: 'picked',
                    position,
                    count
                });
            });

            /* eslint-disable lodash/prefer-lodash-method */
            let undraftedCount = yield database.Game.find({
                $nor: [{
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': helpers.getDocumentID(user)
                        }
                    }
                }, {
                    'teams.captain': helpers.getDocumentID(user)
                }],
                'draft.pool.players.user': helpers.getDocumentID(user)
            }).count().exec();
            /* eslint-enable lodash/prefer-lodash-method */
            draftStats.push({
                type: 'undrafted',
                count: undraftedCount
            });

            user.stats.draft = draftStats;
        }

        {
            let rating = yield database.Rating.findOne({
                user: helpers.getDocumentID(user)
            }).sort('-date').exec();

            if (rating) {
                user.stats.rating.mean = rating.after.mean;
                user.stats.rating.deviation = rating.after.deviation;
            }
        }

        {

            user.stats.roles = yield _(ROLES).keys().map(
                /* eslint-disable lodash/prefer-lodash-method */
                role => database.Game.find({
                    'teams.composition': {
                        $elemMatch: {
                            'role': role,
                            'players.user': helpers.getDocumentID(user)
                        }
                    }
                }).count().exec().then(count => ({
                    role,
                    count
                }))
                /* eslint-enable lodash/prefer-lodash-method */
            ).value();
        }

        {
            user.stats.total.captain = yield database.Game.count({
                'teams.captain': helpers.getDocumentID(user)
            }).count().exec();
            user.stats.total.player = yield database.Game.count({
                'teams.composition.players.user': helpers.getDocumentID(user)
            }).count().exec();
        }

        {
            user.stats.replaced.into = yield database.Game.count({
                $nor: [{
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': helpers.getDocumentID(user)
                        }
                    }
                }, {
                    'teams.captain': helpers.getDocumentID(user)
                }],
                'teams.composition.players.user': helpers.getDocumentID(user)
            }).count().exec();
            user.stats.replaced.out = yield database.Game.count({
                'teams.composition.players': {
                    $elemMatch: {
                        'user': helpers.getDocumentID(user),
                        'replaced': true
                    }
                }
            }).count().exec();
        }

        yield user.save();
        yield updateCachedUser(user);
    }

    process.exit(0);
});
