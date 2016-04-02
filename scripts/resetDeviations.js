'use strict';

const co = require('co');

var database = require('./database');

co(function*() {
    let users = yield database.User.find({}).exec();

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
});
