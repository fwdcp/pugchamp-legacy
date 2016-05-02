const _ = require('lodash');

module.exports = {
    getDocumentID: function getDocumentID(info) {
        if (_.hasIn(info, 'toHexString')) {
            return info.toHexString();
        }

        if (_.isString(info)) {
            return info;
        }

        if (_.isObject(info)) {
            if (_.hasIn(info, '_id') && _.hasIn(info._id, 'toHexString')) {
                return info._id.toHexString();
            }

            if (_.hasIn(info, 'id')) {
                return info.id;
            }
        }

        return null;
    },
    promiseDelay: function(delay, value, fail) {
        return new Promise(function(resolve, reject) {
            if (!fail) {
                setTimeout(resolve, delay, value);
            }
            else {
                setTimeout(reject, delay, value);
            }
        });
    }
};
