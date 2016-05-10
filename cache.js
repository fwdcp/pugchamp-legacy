'use strict';

const bluebird = require('bluebird');
const config = require('config');
const debug = require('debug')('pugchamp:util:cache');
const redis = require('redis');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

var client = redis.createClient(config.get('server.redis'));

client.on('error', function(err) {
    debug(`Redis encountered error: ${err.stack || err}`);
});

module.exports = client;
