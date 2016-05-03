/* eslint no-console: "off", no-process-exit: "off" */
'use strict';

const _ = require('lodash');
const argv = require('yargs').argv;
const co = require('co');

var database = require('../database');

co(function*() {
    try {
        let users;

        if (_.size(argv._) > 0) {
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
            let mean = user.stats.rating.mean;

            let oldDeviation = user.stats.rating.deviation;
            let newDeviation = user.stats.rating.deviation;

            let oldLow = user.stats.rating.low;
            let oldHigh = user.stats.rating.high;

            if (oldLow > 0 && oldHigh < 3000) {
                newDeviation = Math.min(mean / 3, (3000 - mean) / 3);

                user.stats.rating.deviation = newDeviation;

                let newLow = user.stats.rating.low;
                let newHigh = user.stats.rating.high;

                console.log(`${user.alias} rating was adjusted from ${mean}+-${oldDeviation} (${oldLow}-${oldHigh}) to ${mean}+-${newDeviation} (${newLow}-${newHigh})`)
            }

            let newRating = new database.Rating({
                user,
                date: new Date(),
                before: {
                    mean,
                    deviation: oldDeviation
                },
                after: {
                    mean,
                    deviation: newDeviation
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
