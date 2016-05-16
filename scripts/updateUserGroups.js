/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').boolean('a').argv;
const co = require('co');
const config = require('config');
const debug = require('debug')('pugchamp:scripts:updateUserGroups');
const HttpStatus = require('http-status-codes');
const rp = require('request-promise');

const helpers = require('../helpers');

var database = require('../database');

co(function*() {
    const USER_GROUPS = config.has('app.users.groups') ? config.get('app.users.groups') : {};

    try {
        let users;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({
                '_id': {
                    $in: argv._
                }
            }, 'steamID groups').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({}, 'steamID groups').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        debug(`updating user groups for ${_.size(users)} users`);

        let cacheUpdatesRequired = [];

        for (let user of users) {
            let userID = helpers.getDocumentID(user);

            let oldGroups = user.groups;

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
                        continue;
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
                    continue;
                }
            }

            if (_.size(_.xor(user.groups, oldGroups)) > 0) {
                cacheUpdatesRequired.push(userID);
            }

            yield user.save();
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
