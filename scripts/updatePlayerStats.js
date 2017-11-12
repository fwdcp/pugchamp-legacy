/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updatePlayerStats');
const distributions = require('distributions');
const math = require('mathjs');

const helpers = require('../helpers');

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

(async function() {
    const DRAFT_ORDER = config.get('app.draft.order');
    const ROLES = config.get('app.games.roles');

    try {
        let users;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            users = await database.User.find({
                '_id': {
                    $in: argv._
                }
            }, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            users = await database.User.find({}, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        debug(`updating player stats for ${_.size(users)} users`);

        for (let user of users) {
            let userID = helpers.getDocumentID(user);

            {
                /* eslint-disable lodash/prefer-lodash-method */
                let captainGames = await database.Game.find({
                    'teams.captain': userID,
                    'status': 'completed',
                    'score': {
                        $exists: true
                    }
                });
                /* eslint-enable lodash/prefer-lodash-method */

                user.stats.captainRecord = _.countBy(captainGames, function(game) {
                    let gameUserInfo = helpers.getGameUserInfo(game, user);
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
                let captainGames = await database.Game.find({
                    'teams.captain': userID,
                    'status': 'completed',
                    'score': {
                        $exists: true
                    }
                });
                /* eslint-enable lodash/prefer-lodash-method */

                let captainScores = _(captainGames).map(function(game) {
                    if (game.stats.dominanceScore) {
                        let gameUserInfo = helpers.getGameUserInfo(game, user);

                        if (gameUserInfo) {
                            let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

                            if (teamIndex === 0) {
                                return game.stats.dominanceScore;
                            }
                            else if (teamIndex === 1) {
                                return -1 * game.stats.dominanceScore;
                            }
                        }
                    }

                    return null;
                }).filter(_.isNumber).value();

                user.stats.captainScore = calculatePredictionInterval(captainScores);
            }

            {
                /* eslint-disable lodash/prefer-lodash-method */
                let playerGames = await database.Game.find({
                    'teams.composition.players.user': userID,
                    'status': 'completed',
                    'score': {
                        $exists: true
                    }
                });
                /* eslint-enable lodash/prefer-lodash-method */

                user.stats.playerRecord = _.countBy(playerGames, function(game) {
                    let gameUserInfo = helpers.getGameUserInfo(game, user);
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
                let playerGames = await database.Game.find({
                    'teams.composition.players.user': userID,
                    'status': 'completed',
                    'score': {
                        $exists: true
                    }
                });
                /* eslint-enable lodash/prefer-lodash-method */

                let playerScores = _(playerGames).map(function(game) {
                    if (game.stats.dominanceScore) {
                        let gameUserInfo = helpers.getGameUserInfo(game, user);

                        if (gameUserInfo) {
                            let teamIndex = _.indexOf(game.teams, gameUserInfo.team);

                            if (teamIndex === 0) {
                                return game.stats.dominanceScore;
                            }
                            else if (teamIndex === 1) {
                                return -1 * game.stats.dominanceScore;
                            }
                        }
                    }

                    return null;
                }).filter(_.isNumber).value();

                user.stats.playerScore = calculatePredictionInterval(playerScores);
            }

            {
                let draftStats = [];

                let captainGameCount = await database.Game.count({
                    'teams.captain': userID
                }).count().exec();
                draftStats.push({
                    type: 'captain',
                    count: captainGameCount
                });

                let draftPositions = {};

                let playersPicked = _(DRAFT_ORDER).filter(turn => (turn.type === 'playerPick' || turn.type === 'playerOrCaptainRolePick')).size();
                for (let i = 1; i <= playersPicked; i++) {
                    draftPositions[i] = 0;
                }

                /* eslint-disable lodash/prefer-lodash-method */
                let draftedGames = await database.Game.find({
                    'draft.choices': {
                        $elemMatch: {
                            'type': 'playerPick',
                            'player': userID
                        }
                    }
                }).exec();
                /* eslint-enable lodash/prefer-lodash-method */
                for (let game of draftedGames) {
                    let position = 0;

                    for (let choice of game.draft.choices) {
                        if (choice.type === 'playerPick' || choice.type === 'playerOrCaptainRolePick') {
                            position++;

                            if (helpers.getDocumentID(choice.player) === userID) {
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
                let undraftedCount = await database.Game.find({
                    $nor: [{
                        'draft.choices': {
                            $elemMatch: {
                                'type': {
                                    $in: ['playerPick', 'playerOrCaptainRolePick']
                                },
                                'player': userID
                            }
                        }
                    }, {
                        'teams.captain': userID
                    }],
                    'draft.pool.players.user': userID
                }).count().exec();
                /* eslint-enable lodash/prefer-lodash-method */
                draftStats.push({
                    type: 'undrafted',
                    count: undraftedCount
                });

                user.stats.draft = draftStats;
            }

            {
                let rating = await database.Rating.findOne({
                    user: userID
                }).sort('-date').exec();

                if (rating) {
                    user.stats.rating.mean = rating.after.mean;
                    user.stats.rating.deviation = rating.after.deviation;
                }
            }

            {

                user.stats.roles = await Promise.all(_(ROLES).keys().map(
                    /* eslint-disable lodash/prefer-lodash-method */
                    role => database.Game.find({
                        'teams.composition': {
                            $elemMatch: {
                                'role': role,
                                'players.user': userID
                            }
                        }
                    }).count().exec().then(count => ({
                        role,
                        count
                    }))
                    /* eslint-enable lodash/prefer-lodash-method */
                ).value());
            }

            {
                user.stats.total.captain = await database.Game.count({
                    'teams.captain': userID
                }).count().exec();
                user.stats.total.player = await database.Game.count({
                    'teams.composition.players.user': userID
                }).count().exec();
            }

            {
                user.stats.replaced.into = await database.Game.count({
                    $nor: [{
                        'draft.choices': {
                            $elemMatch: {
                                'type': {
                                    $in: ['playerPick', 'playerOrCaptainRolePick']
                                },
                                'player': userID
                            }
                        }
                    }, {
                        'teams.captain': userID
                    }],
                    'teams.composition.players.user': userID
                }).count().exec();
                user.stats.replaced.out = await database.Game.count({
                    'teams.composition.players': {
                        $elemMatch: {
                            'user': userID,
                            'replaced': true
                        }
                    }
                }).count().exec();
            }

            await user.save();
        }

        await helpers.runAppScript('updateUserCache', argv._);

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
})();
