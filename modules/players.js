'use strict';

const _ = require('lodash');
const config = require('config');
const hbs = require('hbs');
const HttpStatus = require('http-status-codes');
const humanize = require('humanize');

const helpers = require('../helpers');

module.exports = function(app, cache, chance, database, io, self) {
    const ROLES = config.get('app.games.roles');

    async function getPlayerList(inactive) {
        let keyName;

        if (inactive) {
            keyName = 'allPlayerList';
        }
        else {
            keyName = 'activePlayerList';
        }

        let cacheResponse = await cache.getAsync(keyName);

        if (!cacheResponse) {
            await self.updateUserCache();
            cacheResponse = await cache.getAsync(keyName);
        }

        return JSON.parse(cacheResponse);
    }

    self.updatePlayerStats = async function updatePlayerStats(...players) {
        await helpers.runAppScript('updatePlayerStats', _.map(players, player => helpers.getDocumentID(player)));
    };

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

    self.getPlayerPage = async function getPlayerPage(player) {
        let cacheResponse = await cache.getAsync(`playerPage-${helpers.getDocumentID(player)}`);

        if (!cacheResponse) {
            await self.updateUserCache(player);
            cacheResponse = await cache.getAsync(`playerPage-${helpers.getDocumentID(player)}`);
        }

        return JSON.parse(cacheResponse);
    };

    app.get('/player/:steam', async function(req, res) {
        let user = await database.User.findOne({
            'steamID': req.params.steam
        }).exec();

        if (user) {
            res.render('player', await self.getPlayerPage(user));
        }
        else {
            res.status(HttpStatus.NOT_FOUND).render('notFound');
        }
    });

    app.get('/players', async function(req, res) {
        res.render('playerList', {
            players: await getPlayerList(self.isUserAdmin(req.user))
        });
    });
};
