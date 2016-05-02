'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const HttpStatus = require('http-status-codes');
const rp = require('request-promise');

const helpers = require('../helpers');

var cache = require('../cache');
var database = require('../database');

function updateCachedUser(user) {
    return co(function*() {
        let userID = helpers.getDocumentID(user);
        user = yield database.User.findById(userID);

        yield cache.setAsync(`user-${userID}`, JSON.stringify(user.toObject()));
    });
}

co(function*() {
    const USER_GROUPS = config.has('app.users.groups') ? config.get('app.users.groups') : {};

    /* eslint-disable lodash/prefer-lodash-method */
    let users = yield database.User.find({}, 'steamID groups').exec();
    /* eslint-enable lodash/prefer-lodash-method */

    for (let user of users) {
        user.groups = [];

        for (let groupID of _.keys(USER_GROUPS)) {
            let groupInfo = USER_GROUPS[groupID];

            let authorization = _.find(groupInfo.authorizations, ['user', user.steamID]);
            if (authorization) {
                if (authorization.authorized) {
                    user.groups.push(groupID);
                }

                continue;
            }

            try {
                let response = yield rp({
                    resolveWithFullResponse: true,
                    simple: false,
                    qs: {
                        user: user.steamID
                    },
                    uri: groupInfo.api
                });

                if (response.statusCode === HttpStatus.OK) {
                    user.groups.push(groupID);
                }
                else if (response.statusCode === HttpStatus.FORBIDDEN) {
                    continue;
                }
            }
            catch (err) {
                // ignore
            }

            if (_.has(groupInfo, 'default') && groupInfo.default) {
                user.groups.push(groupID);
            }
        }

        yield user.save();
        yield updateCachedUser(user);
    }

    process.exit(0);
});
