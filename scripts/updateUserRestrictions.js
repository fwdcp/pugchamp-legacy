/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const co = require('co');
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updateUserRestrictions');
const HttpStatus = require('http-status-codes');
const moment = require('moment');
const rp = require('request-promise');

const helpers = require('../helpers');

const USER_AUTHORIZATIONS = config.has('app.users.authorizations') ? config.get('app.users.authorizations') : [];
const USER_AUTHORIZATION_DEFAULT = config.has('app.users.authorizationDefault') ? config.get('app.users.authorizationDefault') : true;
const USER_AUTHORIZATION_APIS = config.has('app.users.authorizationAPIs') ? config.get('app.users.authorizationAPIs') : [];

var cache = require('../cache');
var database = require('../database');

function checkUserAuthorization(user) {
    return co(function*() {
        for (let authorization of USER_AUTHORIZATIONS) {
            if (authorization.user === user.steamID) {
                return authorization.authorized;
            }
        }

        for (let authorizationAPI of USER_AUTHORIZATION_APIS) {
            try {
                let response = yield rp({
                    resolveWithFullResponse: true,
                    simple: false,
                    qs: {
                        user: user.steamID
                    },
                    uri: authorizationAPI
                });

                if (response.statusCode === HttpStatus.OK) {
                    return true;
                }
                else if (response.statusCode === HttpStatus.FORBIDDEN) {
                    return false;
                }
                else {
                    continue;
                }
            }
            catch (err) {
                continue;
            }
        }

        return USER_AUTHORIZATION_DEFAULT;
    });
}

co(function*() {
    const CAPTAIN_GAME_REQUIREMENT = config.get('app.users.captainGameRequirement');
    const CURRENT_DRAFT_RESTRICTIONS = {
        aspects: ['sub'],
        reasons: ['You are involved in a currently occurring draft.']
    };
    const CURRENT_GAME_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain'],
        reasons: ['You are involved in a currently active game.']
    };
    const CURRENT_SUBSTITUTE_REQUEST_RESTRICTIONS = {
        aspects: ['start', 'captain'],
        reasons: ['You are currently applying to a substitute request.']
    };
    const DRAFT_EXPIRE_COOLDOWN_RESTRICTIONS = {
        aspects: ['captain'],
        reasons: ['You are currently on a captain cooldown for allowing a draft to expire.']
    };
    const MIN_GAME_RESTRICTIONS = {
        aspects: ['captain'],
        reasons: ['You cannot captain because you do not meet the requirement for games played.']
    };
    const NOT_READY_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain', 'chat', 'support'],
        reasons: ['Your account is not [set up](/user/settings) properly.']
    };
    const UNAUTHORIZED_ADMIN_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain'],
        reasons: ['You are not authorized to play in this system.']
    };
    const UNAUTHORIZED_USER_RESTRICTIONS = {
        aspects: ['sub', 'start', 'captain', 'chat', 'support'],
        reasons: ['You are not authorized to use this system.']
    };

    try {
        let users;

        if (argv.a) {
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

        debug(`updating user restrictions for ${_.size(users)} users`);

        let cacheUpdatesRequired = [];

        for (let user of users) {
            let userID = helpers.getDocumentID(user);

            let restrictions = [];

            if (!user.setUp) {
                restrictions.push(NOT_READY_RESTRICTIONS);
            }

            let authorized = yield checkUserAuthorization(user);
            if (user.authorized !== authorized) {
                user.authorized = authorized;

                yield user.save();

                cacheUpdatesRequired.push(userID);
            }
            if (!user.authorized) {
                if (!user.admin) {
                    restrictions.push(UNAUTHORIZED_USER_RESTRICTIONS);
                }
                else {
                    restrictions.push(UNAUTHORIZED_ADMIN_RESTRICTIONS);
                }
            }

            let currentGame = yield database.Game.findOne({
                $or: [{
                    'teams.captain': userID
                }, {
                    'teams.composition.players.user': userID
                }],
                status: {
                    $in: ['initializing', 'launching', 'live']
                }
            });
            if (currentGame) {
                restrictions.push(CURRENT_GAME_RESTRICTIONS);
            }

            if (yield cache.existsAsync('draftUsers')) {
                let draftUsers = JSON.parse(yield cache.getAsync('draftUsers'));
                if (_.includes(draftUsers, userID)) {
                    restrictions.push(CURRENT_DRAFT_RESTRICTIONS);
                }
            }

            if (yield cache.existsAsync('substituteRequestsCandidates')) {
                let candidates = JSON.parse(yield cache.getAsync('substituteRequestsCandidates'));
                if (_.includes(candidates, userID)) {
                    restrictions.push(CURRENT_SUBSTITUTE_REQUEST_RESTRICTIONS);
                }
            }

            if (_.isNil(user.stats.total.player) || user.stats.total.player < CAPTAIN_GAME_REQUIREMENT) {
                restrictions.push(MIN_GAME_RESTRICTIONS);
            }

            if (yield cache.existsAsync(`draftExpired-${userID}`)) {
                let draftExpired = JSON.parse(yield cache.getAsync(`draftExpired-${userID}`));
                if (draftExpired) {
                    restrictions.push(DRAFT_EXPIRE_COOLDOWN_RESTRICTIONS);
                }
            }

            /* eslint-disable lodash/prefer-lodash-method */
            let activeRestrictions = yield database.Restriction.find({
                'user': userID,
                'active': true
            });
            /* eslint-enable lodash/prefer-lodash-method */

            for (let restriction of activeRestrictions) {
                if (!restriction.expires || moment().isBefore(restriction.expires)) {
                    let reason;

                    if (_.size(restriction.aspects) !== 0) {
                        let formattedAspects = restriction.aspects.join(', ');
                        let formattedExpiration = restriction.expires ? moment(restriction.expires).fromNow() : 'never';
                        let formattedReason = restriction.reason ? ` for the reason: ${restriction.reason}` : '.';
                        reason = `You are currently restricted (aspects: ${formattedAspects}) (expires: ${formattedExpiration})${formattedReason}`;
                    }
                    else {
                        let formattedReason = restriction.reason ? ` for the reason: ${restriction.reason}` : '.';
                        reason = `You have received a warning${formattedReason}`;
                    }

                    restrictions.push({
                        aspects: restriction.aspects,
                        reasons: [reason]
                    });
                }
                else {
                    restriction.active = false;

                    yield restriction.save();

                    cacheUpdatesRequired.push(userID);
                }
            }

            let combinedRestrictions = _.reduce(restrictions, function(combined, restriction) {
                return {
                    aspects: _.union(combined.aspects, restriction.aspects),
                    reasons: _.concat(combined.reasons, restriction.reasons)
                };
            }, {
                aspects: [],
                reasons: []
            });

            yield cache.setAsync(`userRestrictions-${userID}`, JSON.stringify(combinedRestrictions));
        }

        if (_.size(cacheUpdatesRequired) > 0) {
            yield helpers.runAppScript('updateUserCache', _.uniq(cacheUpdatesRequired));
        }

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
