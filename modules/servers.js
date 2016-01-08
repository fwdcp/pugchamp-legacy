/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var config = require('config');
var lodash = require('lodash');
var ms = require('ms');
var RCON = require('srcds-rcon');

module.exports = function(app, io, self, server) {
    var serverPool = config.get('app.servers.pool');
    var serverTimeout = config.get('app.servers.timeout');

    self.on('getAvailableServers', function(callback) {
        Promise.all(lodash.map(serverPool, function(server) {
            return Promise.race([
                new Promise(function(resolve, reject) {
                    let rcon = RCON({
                        address: server.address,
                        password: server.rcon
                    });

                    rcon.connect().then(function() {
                        return rcon.command('pugchamp_match_info').then(function(result) {
                            let serverInfo = result.trim().split(' ');

                            if (serverInfo[0] === '0') {
                                resolve(server);
                            }
                            else {
                                resolve(false);
                            }
                        });
                    }).catch(function() {
                        resolve(false);
                    });
                }),
                new Promise(function(resolve, reject) {
                    setTimeout(resolve, ms(serverTimeout), false);
                })
            ]);
        })).then(function(results) {
            callback(lodash.compact(results));
        });
    });

    self.emit('getAvailableServers', function(results) {
        console.log(results);
    });
};
