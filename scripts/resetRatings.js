/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const argv = require('yargs').boolean('a').argv;
const co = require('co');

var database = require('../database');

co(function*() {
    try {
        let users;

        if (!argv.a) {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({
                '_id': {
                    $in: argv._
                }
            }, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }
        else {
            /* eslint-disable lodash/prefer-lodash-method */
            users = yield database.User.find({}, 'stats').exec();
            /* eslint-enable lodash/prefer-lodash-method */
        }

        for (let user of users) {
            let oldMean = user.stats.rating.mean;
            let oldDeviation = user.stats.rating.deviation;

            user.stats.rating.mean = 1500;
            user.stats.rating.deviation = 500;

            let newRating = new database.Rating({
                user,
                date: new Date(),
                before: {
                    mean: oldMean,
                    deviation: oldDeviation
                },
                after: {
                    mean: 1500,
                    deviation: 500
                }
            });

            yield newRating.save();
            yield user.save();
        }

        process.exit(0);
    }
    catch (err) {
        console.log(err.stack);
        process.exit(1);
    }
});
