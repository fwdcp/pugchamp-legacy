'use strict';

const _ = require('lodash');
const config = require('config');
const hbs = require('hbs');
const math = require('mathjs');
const moment = require('moment');

module.exports = function(app, chance, database, io, self) {
    const HIDE_CAPTAINS = config.get('app.games.hideCaptains');
    const HIDE_DRAFT_STATS = config.get('app.users.hideDraftStats');
    const HIDE_RATINGS = config.get('app.users.hideRatings');
    const SEPARATE_CAPTAIN_POOL = config.get('app.draft.separateCaptainPool');
    const SITE_BRAND_NAME = config.has('app.common.siteBrandName') ? config.get('app.common.siteBrandName') : '';
    const SITE_LOGO = config.has('app.common.siteLogo') ? config.get('app.common.siteLogo') : '';
    const SITE_NAME = config.get('app.common.siteName');
    const SITE_SUBTITLE = config.get('app.common.siteSubtitle');
    const SITE_THEME = config.get('app.common.siteTheme');

    self.promiseDelay = function(delay, value, fail) {
        return new Promise(function(resolve, reject) {
            if (!fail) {
                setTimeout(resolve, delay, value);
            }
            else {
                setTimeout(reject, delay, value);
            }
        });
    };

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

    hbs.registerHelper('toJSON', function(object) {
        return JSON.stringify(object);
    });
    hbs.registerHelper('momentFromNow', function(date) {
        return moment(date).fromNow();
    });
    hbs.registerHelper('momentFormat', function(date) {
        return moment(date).format('llll');
    });
    hbs.registerHelper('round', function(number, decimals) {
        if (!decimals) {
            decimals = 0;
        }

        return math.round(number, decimals);
    });

    // NOTE: must be here in order to take effect for all pages
    app.use(function(req, res, next) {
        res.locals.hideCaptains = HIDE_CAPTAINS;
        res.locals.hideDraftStats = HIDE_DRAFT_STATS;
        res.locals.hideRatings = HIDE_RATINGS;
        res.locals.separateCaptainPool = SEPARATE_CAPTAIN_POOL;
        res.locals.siteBrandName = SITE_BRAND_NAME;
        res.locals.siteLogo = SITE_LOGO;
        res.locals.siteName = SITE_NAME;
        res.locals.siteSubtitle = SITE_SUBTITLE;
        res.locals.siteTheme = SITE_THEME;
        next();
    });

    app.use(function(req, res, next) {
        res.locals.currentUser = req.user ? req.user.toObject() : null;
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
