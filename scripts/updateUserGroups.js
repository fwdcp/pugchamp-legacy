/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').argv;
const co = require('co');
const config = require('config');
const HttpStatus = require('http-status-codes');
const rp = require('request-promise');

const helpers = require('../helpers');

var database = require('../database');

co(function*() {
    const USER_GROUPS = config.has('app.users.groups') ? config.get('app.users.groups') : {};

    try {
        let users;

        if (_.size(argv._) > 0) {
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
        }

        yield helpers.runScript('scripts/updateUserCache.js', _.map(users, user => helpers.getDocumentID(user)), {
            cwd: process.cwd()
        });

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
