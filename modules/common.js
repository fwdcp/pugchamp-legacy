/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');

module.exports = function(app, database, io, self, server) {
    self.getDocumentID = function getDocumentID(info) {
        if (_.hasIn(info, 'toHexString')) {
            return info.toHexString();
        }

        if (_.isString(info)) {
            return info;
        }

        if (_.isObject(info)) {
            if (_.hasIn(info, '_id') && _hasIn(info._id, 'toHexString')) {
                return info._id.toHexString();
            }

            if (_.hasIn(info, 'id')) {
                return info.id;
            }
        }

        return null;
    };

    app.get('/', function(req, res) {
        res.render('index');
    });
};
