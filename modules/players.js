'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const humanize = require('humanize');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const ROLES = config.get('app.games.roles');

    /**
     * @async
     */
    function getPlayerList(inactive) {
        return co(function*() {
            let keyName;

            if (inactive) {
                keyName = 'allPlayerList';
            }
            else {
                keyName = 'activePlayerList';
            }

            let cacheResponse = yield cache.getAsync(keyName);

            if (!cacheResponse) {
                yield self.updateUserCache();
                cacheResponse = yield cache.getAsync(keyName);
            }

            return JSON.parse(cacheResponse);
        });
    }

    /**
     * @async
     */
    self.updatePlayerStats = co.wrap(function* updatePlayerStats(...players) {
        yield helpers.runAppScript('updatePlayerStats', _.map(players, player => helpers.getDocumentID(player)));
    });

    hbs.registerHelper('draftStatToRow', function(stat) {
        if (stat.type === 'captain') {
            return JSON.stringify(['Captain', stat.count]);
        }
        else if (stat.type === 'picked') {
            return JSON.stringify([`Picked ${humanize.ordinal(stat.position)}`, stat.count]);
        }
        else if (stat.type === 'undrafted') {
            return JSON.stringify(['Undrafted', stat.count]);
        }
    });
    hbs.registerHelper('ratingStatToRow', function(stat) {
        return `[new Date("${stat.date}"),${stat.after.mean},${stat.after.low},${stat.after.high}]`;
    });
    hbs.registerHelper('roleStatToRow', function(stat) {
        return JSON.stringify([ROLES[stat.role].name, stat.count]);
    });

    /**
     * @async
     */
    self.getPlayerGamesPage = co.wrap(function* getPlayerGamesPage(player) {
        let cacheResponse = yield cache.getAsync(`playerGamesPage-${helpers.getDocumentID(player)}`);

        if (!cacheResponse) {
            yield self.updateUserCache(player);
            cacheResponse = yield cache.getAsync(`playerGamesPage-${helpers.getDocumentID(player)}`);
        }

        return JSON.parse(cacheResponse);
    });

    /**
     * @async
     */
    self.getPlayerPage = co.wrap(function* getPlayerPage(player) {
        let cacheResponse = yield cache.getAsync(`playerPage-${helpers.getDocumentID(player)}`);

        if (!cacheResponse) {
            yield self.updateUserCache(player);
            cacheResponse = yield cache.getAsync(`playerPage-${helpers.getDocumentID(player)}`);
        }

        return JSON.parse(cacheResponse);
    });

    app.get('/player/:steam/games', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            'steamID': req.params.steam
        }).exec();

        if (user) {
            res.render('player', yield self.getPlayerGamesPage(user));
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    }));

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            'steamID': req.params.steam
        }).exec();

        if (user) {
            res.render('player', yield self.getPlayerPage(user));
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    }));

    app.get('/players', co.wrap(function*(req, res) {
        res.render('playerList', {
            players: yield getPlayerList(self.isUserAdmin(req.user))
        });
    }));
};
