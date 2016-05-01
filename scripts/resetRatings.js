'use strict';

const co = require('co');

var database = require('../database');

co(function*() {
    /* eslint-disable lodash/prefer-lodash-method */
    let users = yield database.User.find({}, 'alias stats.rating').exec();
    /* eslint-enable lodash/prefer-lodash-method */

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
});
