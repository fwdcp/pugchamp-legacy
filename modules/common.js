/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const config = require('config');

module.exports = function(app, database, io, self, server) {
    self.getDocumentID = function getDocumentID(info) {
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
    };

    // NOTE: must be here in order to take effect for all pages
    app.use(function(req, res, next) {
        res.locals.user = req.user ? req.user.toObject() : null;
        next();
    });

    if (config.has('app.pages')) {
        const PAGES = config.get('app.pages');

        app.use(function(req, res, next) {
            res.locals.pages = PAGES;
            next();
        });

        _.forEach(PAGES, function(page) {
            if (page.view) {
                app.get(page.url, function(req, res) {
                    res.render(page.view);
                });
            }
        });
    }

    app.get('/', function(req, res) {
        res.render('index');
    });
};
